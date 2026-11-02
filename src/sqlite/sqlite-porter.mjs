// SQLite owns the stemming algorithm. The helper retains only one lexeme, and
// shares the index connection's lifetime; the cache contains no document text.
export function createStemmer(db) {
  db.exec(`CREATE VIRTUAL TABLE porter_helper USING fts5(token, tokenize='porter ascii');
    CREATE VIRTUAL TABLE porter_vocabulary USING fts5vocab(porter_helper, 'instance');`);
  const insert = db.prepare('INSERT INTO porter_helper(token) VALUES (?)');
  const clear = db.prepare('DELETE FROM porter_helper');
  const vocabulary = db.prepare('SELECT term FROM porter_vocabulary ORDER BY offset');
  const cache = new Map();
  return term => {
    if (!/^[a-z0-9_$]+$/i.test(term)) return undefined;
    if (!cache.has(term)) {
      clear.run();
      insert.run(term);
      cache.set(term, vocabulary.all().map(row => row.term).join(' ') || undefined);
    }
    return cache.get(term);
  };
}

const quote = text => `"${text.replaceAll('"', '""')}"`;

export function porterTerm(term, stem) {
  const base = quote(term);
  const alias = stem(term);
  if (!alias) return `tokens : ${base}`;
  if (alias === term) return `{tokens stems} : ${base}`;
  // Different aliases are separate native phrases: their BM25 evidence adds.
  return `(tokens : ${base} OR stems : ${quote(alias)})`;
}
