import { measured } from '../timing.ts';
// Experimental only; not registered by the production extension.
import { compactedEntries } from '../history.ts';
import { lex, locatorText, queryTerms, renderLocators, recallPageFromCandidates } from '../locator.ts';

export class CompactionIndex {
  constructor(timer) { this.timer = timer; }
  entries = [];
  documents = new Map(); // SessionManager entry references; never retained full-text copies.
  postings = new Map(); // term -> Map(entry position -> first lexical occurrence)
  seen = new Set();
  builds = 0;
  indexed = 0;

  add(entry, recency) {
    if (entry.message.role !== 'user' && entry.message.role !== 'assistant') return;
    if (this.seen.has(entry.id)) return;
    this.seen.add(entry.id);
    const text = locatorText(entry.message);
    if (!text) return;
    this.documents.set(recency, entry);
    let order = 0;
    for (const { term, offset } of lex(text)) {
      let posting = this.postings.get(term);
      if (!posting) this.postings.set(term, posting = new Map());
      if (!posting.has(recency)) posting.set(recency, { offset, order });
      order++;
    }
    this.indexed++;
  }

  // Call after compaction; queries also call this to account for branch selection/reset.
  // SessionManager entries are assumed immutable. Changed object references force rebuild.
  sync(branch) {
    const next = measured(this.timer, "branch_selection", () => compactedEntries(branch));
    let prefix = next.length >= this.entries.length;
    for (let i = 0; prefix && i < this.entries.length; i++) prefix = next[i] === this.entries[i];
    const additions = next.slice(this.entries.length);
    const newIds = new Set();
    for (const entry of additions) {
      if (entry.message.role !== 'user' && entry.message.role !== 'assistant') continue;
      if (this.seen.has(entry.id) || newIds.has(entry.id)) prefix = false;
      newIds.add(entry.id);
    }
    if (!prefix || !this.builds) {
      this.documents.clear(); this.postings.clear(); this.seen.clear();
      this.builds++;
      this.timer?.mark?.("index_maintenance", {kind:this.builds===1?"initial_build":"branch_rebuild",trigger:"lazy_context_or_tool_lookup",execution:"synchronous_main_thread",entries:next.length});
      measured(this.timer, "index_build_tokenize_postings", () => {
        for (let i = next.length - 1; i >= 0; i--) this.add(next[i], i);
      });
    } else if (additions.length) {
      this.timer?.mark?.("index_maintenance", {kind:"incremental_update",trigger:"lazy_context_or_tool_lookup",execution:"synchronous_main_thread",entries:additions.length});
      measured(this.timer, "index_update_tokenize_postings", () => {
        for (let i = this.entries.length; i < next.length; i++) this.add(next[i], i);
      });
    }
    this.entries = next;
  }

  collect(query, branch) {
    // Timed end-to-end: reselect current compacted branch and verify index freshness.
    measured(this.timer, "index_sync", () => this.sync(branch));
    const terms = measured(this.timer, "query_tokenization", () => queryTerms(query));
    const hits = new Map(), frequency = new Map();
    measured(this.timer, "postings_search", () => {
    for (const term of terms) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      frequency.set(term, posting.size);
      for (const [recency, position] of posting) {
        let matched = hits.get(recency);
        if (!matched) hits.set(recency, matched = []);
        matched.push({ term, ...position });
      }
    }
    });
    const candidates = [];
    measured(this.timer, "candidate_materialization", () => {
    for (const [recency, matched] of hits) {
      matched.sort((a, b) => a.order - b.order);
      const entry = this.documents.get(recency);
      candidates.push({ id: entry.id, date: entry.timestamp.slice(0, 10), role: entry.message.role,
        text: locatorText(entry.message), offset: matched[0].offset,
        matches: new Set(matched.map(x => x.term)), offsets: new Map(matched.map(x => [x.term, x.offset])), recency });
    }
    });
    return { candidates, frequency, documents: this.documents.size };
  }

  query(query, branch) {
    const found = this.collect(query, branch);
    return renderLocators(found.candidates, found.frequency, found.documents, this.timer);
  }

  recall(query, branch, options = {}) {
    return recallPageFromCandidates(this.collect(query, branch), options, this.timer);
  }
}
