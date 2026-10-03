import { createIndex } from '../prototype/soft-match-sqlite/index.mjs';

export function createEngine(documents) {
  const index = createIndex(documents);
  return {
    searchAuto(question) {
      return index.search(question, { automatic: true, limit: documents.length }).results;
    },
    searchRaw(query, options) {
      return index.searchRaw(query, options);
    },
    dispose() {
      index.close();
    },
  };
}
