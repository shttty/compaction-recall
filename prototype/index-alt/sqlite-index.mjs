import { DatabaseSync } from 'node:sqlite';
import { CompactionIndex } from '../../benchmark/archive/js-runtime/inverted-index.mjs';
import { lex, locatorText, queryTerms } from '../../benchmark/archive/js-runtime/locator.mjs';
import { measured } from '../../src/timing.mjs';

// Both variants index the literal, space-separated unique lex() terms. B1's
// ASCII tokenizer preserves _$ and every non-ASCII character without folding.
// B2 measures trigram substring membership without exact lexical filtering.
// ASCII-only folding preserves original UTF-16 offsets (Unicode lowercasing
// can change string length); lex query terms contain only ASCII and Han.
const foldAscii = text => text.replace(/[A-Z]/g, char => char.toLowerCase());
export class SqliteIndex extends CompactionIndex {
  constructor(timer, variant = 'B1') {
    super(timer);
    if (variant !== 'B1' && variant !== 'B2') throw new Error(`Unknown SQLite variant: ${variant}`);
    this.variant = variant;
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA temp_store=MEMORY; PRAGMA journal_mode=MEMORY;');
    const tokenizer = variant === 'B1' ? "ascii tokenchars '_$'" : 'trigram case_sensitive 1';
    // Trigram phrases longer than three characters require full detail. Using
    // detail=none here would reject those queries rather than merely save RAM.
    this.db.exec(`CREATE VIRTUAL TABLE terms USING fts5(tokens, content='',
      tokenize="${tokenizer}", detail=${variant === 'B1' ? 'none' : 'full'}, columnsize=0)`);
    this.insert = this.db.prepare('INSERT INTO terms(rowid, tokens) VALUES (?, ?)');
    this.search = this.db.prepare('SELECT rowid FROM terms WHERE terms MATCH ? ORDER BY rowid');
    this.rows = [];
    this.sqlBuilds = 0;
    this.shortTermScans = 0;
    this.offsetFallbacks = 0;
  }

  resetForBuild() {
    if (this.sqlBuilds === this.builds) return;
    this.db.exec("INSERT INTO terms(terms) VALUES ('delete-all')");
    this.rows.length = 0;
    this.sqlBuilds = this.builds;
  }

  sync(branch) {
    // Inherit production branch freshness, duplicate-ID selection, reverse
    // initial insertion, forward incremental insertion, and maintenance marks.
    if (this.builds && branch.length === this.branch.length &&
        branch.every((entry, i) => entry === this.branch[i])) return;
    this.db.exec('BEGIN');
    try {
      super.sync(branch);
      // add() handles nonempty rebuilds; this also clears an empty rebuild.
      this.resetForBuild();
      this.db.exec('COMMIT');
      for (const entry of this.entries) delete entry.tokens;
    } catch (error) {
      this.db.exec('ROLLBACK');
      // JS state cannot be rolled back with SQLite. Force a complete rebuild
      // on the next sync rather than accepting a partially activated branch.
      this.builds = 0;
      this.sqlBuilds = -1;
      throw error;
    }
  }

  add(entry, recency) {
    this.resetForBuild();
    if (entry.message.role !== 'user' && entry.message.role !== 'assistant') return;
    if (this.seen.has(entry.id)) return;
    this.seen.add(entry.id);
    const text = locatorText(entry.message);
    if (!text) return;
    const terms = entry.tokens instanceof Map
      ? entry.tokens.keys()
      : new Set(Array.from(lex(text), token => token.term)).keys();
    const rowid = this.rows.length + 1;
    this.insert.run(rowid, Array.from(terms).join(' '));
    this.rows.push(recency);
    this.documents.set(recency, entry);
    this.indexed++;
  }

  collect(query, branch) {
    measured(this.timer, 'index_sync', () => this.sync(branch));
    const terms = measured(this.timer, 'query_tokenization', () => queryTerms(query));
    const termRows = new Map();
    measured(this.timer, 'postings_search', () => {
      for (const term of terms) {
        if (this.variant === 'B2' && Array.from(term).length < 3) {
          // FTS5 trigram cannot find short terms. Scan retained original text
          // only for those terms, without lexical filtering. Counting
          // code points, not UTF-16 units, includes astral Han bigrams here.
          this.shortTermScans++;
          const rows = [];
          for (const [recency, entry] of this.documents) {
            if (foldAscii(locatorText(entry.message)).includes(term)) rows.push(recency);
          }
          termRows.set(term, rows);
        } else {
          const phrase = `"${term.replaceAll('"', '""')}"`;
          termRows.set(term, this.search.all(phrase).map(row => this.rows[Number(row.rowid) - 1]));
        }
      }
    });
    return measured(this.timer, 'candidate_materialization', () => {
      const positions = new Map();
      const requested = new Set(terms);
      // B1 re-lexes each candidate once; B2 searches original literal substrings
      // once per query term per candidate. Neither retains positional postings.
      for (const rows of termRows.values()) {
        for (const recency of rows) {
          if (positions.has(recency)) continue;
          const found = new Map();
          const text = locatorText(this.documents.get(recency).message);
          if (this.variant === 'B1') {
            let order = 0;
            for (const { term, offset } of lex(text)) {
              if (requested.has(term) && !found.has(term)) found.set(term, { offset, order });
              order++;
            }
          } else {
            const folded = foldAscii(text);
            for (const term of terms) {
              const offset = folded.indexOf(term);
              // Pretoken-stream membership need not locate a literal original
              // occurrence. Keep that hit; use the document start as an explicit
              // snippet fallback, sorting such matches after located matches.
              found.set(term, { offset: Math.max(0, offset),
                order: offset < 0 ? Infinity : offset, fallback: offset < 0 });
            }
          }
          positions.set(recency, found);
        }
      }
      const hits = new Map(), frequency = new Map();
      // Term-major iteration and insertion rowids reproduce production posting
      // Map order, including the reverse-build / forward-append distinction.
      for (const [term, rows] of termRows) {
        let count = 0;
        for (const recency of rows) {
          const position = positions.get(recency).get(term);
          if (!position) continue;
          if (position.fallback) this.offsetFallbacks++;
          count++;
          let matched = hits.get(recency);
          if (!matched) hits.set(recency, matched = []);
          matched.push({ term, ...position });
        }
        if (count) frequency.set(term, count);
      }
      const candidates = [];
      for (const [recency, matched] of hits) {
        matched.sort((a, b) => a.order - b.order);
        const entry = this.documents.get(recency);
        candidates.push({ id: entry.id, date: entry.timestamp.slice(0, 10), role: entry.message.role,
          text: locatorText(entry.message), offset: matched[0].offset,
          matches: new Set(matched.map(x => x.term)),
          offsets: new Map(matched.map(x => [x.term, x.offset])), recency });
      }
      return { candidates, frequency, documents: this.documents.size };
    });
  }

  stats() {
    const pageSize = this.db.prepare('PRAGMA page_size').get().page_size;
    const pageCount = this.db.prepare('PRAGMA page_count').get().page_count;
    return {
      variant: this.variant,
      storage: ':memory:',
      databaseList: this.db.prepare('PRAGMA database_list').all(),
      tempStore: this.db.prepare('PRAGMA temp_store').get().temp_store,
      journalMode: this.db.prepare('PRAGMA journal_mode').get().journal_mode,
      pageSize, pageCount, sqlitePageBytes: pageSize * pageCount,
      documents: this.documents.size, rows: this.rows.length,
      builds: this.builds, indexed: this.indexed, shortTermScans: this.shortTermScans,
      offsetFallbacks: this.offsetFallbacks,
      tokenizer: this.variant === 'B1' ? "ascii tokenchars '_$'" : 'trigram case_sensitive 1',
      detail: this.variant === 'B1' ? 'none' : 'full', columnsize: 0, contentless: true,
      indexedContent: 'unique pretokenized lex terms joined by ASCII spaces',
      shortTermFallback: this.variant === 'B2' ? 'original-text ASCII-folded substring scan; no lexical filtering' : null,
      membership: this.variant === 'B1' ? 'exact lex terms' : 'pretoken-stream trigram MATCH for >=3 codepoints; original-text substring for shorter terms',
      matchOrder: this.variant === 'B1' ? 'first lexical emission order' : 'first original substring offset; query order breaks ties; unlocated matches last',
      offsetFallback: this.variant === 'B2' ? 'document start (offset 0) when no original literal occurrence; retained hit, counted in offsetFallbacks' : null,
      retainedText: 'original entry references',
      pageBytesCaveat: 'SQLite allocated database pages only; excludes connection/cache/native overhead and JS memory',
    };
  }
}
