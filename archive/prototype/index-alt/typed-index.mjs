import { CompactionIndex } from '../../js-runtime/inverted-index.mjs';
import { lex, locatorText, queryTerms } from '../../js-runtime/locator.mjs';
import { measured } from '../../../src/timing.mjs';

// Each term owns a growable sequence of (recency, offset, lexical order) triples.
// Append order is exactly production Map insertion order, including rebuilds.
export class TypedIndex extends CompactionIndex {
  append(term, recency, offset, order) {
    let posting = this.postings.get(term);
    if (!posting) {
      posting = { values: new Uint32Array(3), length: 0 };
      this.postings.set(term, posting);
    }
    // All occurrences for an entry are added together; keep only its first.
    if (posting.length && posting.values[posting.length - 3] === recency) return;
    if (posting.length === posting.values.length) {
      const values = new Uint32Array(posting.values.length * 2);
      values.set(posting.values);
      posting.values = values;
    }
    const at = posting.length;
    posting.values[at] = recency;
    posting.values[at + 1] = offset;
    posting.values[at + 2] = order;
    posting.length += 3;
  }

  add(entry, recency) {
    if (entry.message.role !== 'user' && entry.message.role !== 'assistant') return;
    if (this.seen.has(entry.id)) return;
    this.seen.add(entry.id);
    const text = locatorText(entry.message);
    if (!text) return;
    this.documents.set(recency, entry);
    if (entry.tokens instanceof Map) {
      for (const [term, { offset, order }] of entry.tokens) {
        this.append(term, recency, offset, order);
      }
    } else {
      let order = 0;
      for (const { term, offset } of lex(text)) {
        this.append(term, recency, offset, order++);
      }
    }
    this.indexed++;
  }

  sync(branch) {
    const previous = this.entries;
    // Retain production branch-prefix detection and latest-duplicate rebuilds.
    super.sync(branch);
    // Drop caches even on skipped duplicates; unchanged queries need no sweep.
    if (this.entries !== previous) {
      for (const entry of this.entries) delete entry.tokens;
    }
  }

  collect(query, branch) {
    measured(this.timer, 'index_sync', () => this.sync(branch));
    const terms = measured(this.timer, 'query_tokenization', () => queryTerms(query));
    const hits = new Map(), frequency = new Map();
    measured(this.timer, 'postings_search', () => {
      for (const term of terms) {
        const posting = this.postings.get(term);
        if (!posting) continue;
        frequency.set(term, posting.length / 3);
        const values = posting.values;
        for (let at = 0; at < posting.length; at += 3) {
          const recency = values[at];
          let matched = hits.get(recency);
          if (!matched) hits.set(recency, matched = []);
          matched.push({ term, offset: values[at + 1], order: values[at + 2] });
        }
      }
    });
    const candidates = [];
    measured(this.timer, 'candidate_materialization', () => {
      for (const [recency, matched] of hits) {
        // lex('fooBar') emits foobar@(0, order 0), foo@(0, order 1).
        // Query 'foo foobar' visits foo first; sorting only by offset would
        // retain that wrong order, changing match insertion and snippet ties.
        matched.sort((a, b) => a.order - b.order);
        const entry = this.documents.get(recency);
        candidates.push({
          id: entry.id,
          date: entry.timestamp.slice(0, 10),
          role: entry.message.role,
          text: locatorText(entry.message),
          offset: matched[0].offset,
          matches: new Set(matched.map(x => x.term)),
          offsets: new Map(matched.map(x => [x.term, x.offset])),
          recency,
        });
      }
    });
    return { candidates, frequency, documents: this.documents.size };
  }

  stats() {
    let postingCount = 0, allocatedTypedBytes = 0;
    for (const { values, length } of this.postings.values()) {
      postingCount += length / 3;
      allocatedTypedBytes += values.byteLength;
    }
    return {
      postingCount,
      logicalTypedBytes: postingCount * 3 * Uint32Array.BYTES_PER_ELEMENT,
      allocatedTypedBytes,
      terms: this.postings.size,
      documents: this.documents.size,
    };
  }
}
