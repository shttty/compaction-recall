import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createStemmer } from './sqlite-porter.mjs';

export function createStore(documents, tokenize) {
  // Latest id wins before the empty check, so a latest empty edit hides older text.
  const byId = new Map();
  documents.forEach((document, i) => {
    const recency = document.sourcePosition ?? document.recency ?? i;
    const previous = byId.get(document.id);
    if (!previous || recency >= previous.recency) byId.set(document.id, {
      id: document.id, text: document.text.normalize('NFKC'), date: document.date, role: document.role, recency,
      timestamp: document.timestamp ?? document.date ?? '',
    });
  });
  const indexedIds = new Set(byId.keys());
  const corpus = [...byId.values()].filter(document => document.text !== '');
  const db = new DatabaseSync(':memory:');
  let match, count, stem, insert, insertMessage, autoFrequency;
  try {
    db.exec(`
      PRAGMA temp_store = MEMORY;
      CREATE VIRTUAL TABLE terms USING fts5(
        tokens, stems, content='', columnsize=1, detail=full,
        tokenize="ascii tokenchars '.'"
      );
      CREATE VIRTUAL TABLE vocabulary USING fts5vocab(terms, 'col');
      CREATE TABLE messages(rowid INTEGER PRIMARY KEY, content_hash BLOB NOT NULL, timestamp TEXT NOT NULL, recency INTEGER NOT NULL);
      BEGIN;
    `);
    stem = createStemmer(db);
    insert = db.prepare('INSERT INTO terms(rowid, tokens, stems) VALUES (?, ?, ?)');
    insertMessage = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?)');
    corpus.forEach((document, i) => insertDocument(document, i + 1));
    db.exec('COMMIT');
    // MATERIALIZED keeps FTS5's bm25 auxiliary call inside its MATCH cursor.
    const scored = `SELECT terms.rowid, bm25(terms, 1.0, 0.5) AS score,
      messages.content_hash, messages.timestamp, messages.recency
      FROM terms JOIN messages ON messages.rowid = terms.rowid
      WHERE terms MATCH ? AND (? < 0 OR messages.recency < ?)`;
    match = db.prepare(`WITH hits AS MATERIALIZED (${scored}), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY content_hash ORDER BY score, timestamp DESC, recency DESC, rowid DESC) AS representative FROM hits
    ) SELECT rowid, score FROM ranked WHERE representative = 1
      ORDER BY score, timestamp DESC, recency DESC, rowid DESC LIMIT ? OFFSET ?`);
    count = db.prepare('SELECT count(DISTINCT content_hash) AS total FROM terms JOIN messages ON messages.rowid = terms.rowid WHERE terms MATCH ? AND (? < 0 OR messages.recency < ?)');
    autoFrequency = db.prepare('SELECT count(*) AS total FROM terms JOIN messages ON messages.rowid = terms.rowid WHERE terms MATCH ? AND (? < 0 OR messages.recency < ?)');
  } catch (error) { db.close(); throw error; }
  function appendDocuments(additions) {
    const seen = new Set(indexedIds);
    const normalized = additions.map((document, index) => {
      if (seen.has(document.id)) throw new Error('Cannot append duplicate index document id');
      seen.add(document.id);
      const recency = document.sourcePosition ?? document.recency ?? corpus.length + index;
      return { id: document.id, text: document.text.normalize('NFKC'), date: document.date, role: document.role, recency, timestamp: document.timestamp ?? document.date ?? '' };
    });
    const added = normalized.filter(document => document.text !== '');
    db.exec('BEGIN');
    try {
      added.forEach((document, index) => insertDocument(document, corpus.length + index + 1));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    for (const document of normalized) indexedIds.add(document.id);
    corpus.push(...added);
  }
  function insertDocument(document, rowid) {
    const tokens = tokenize(document.text);
    insert.run(rowid, tokens.join(' '), tokens.map(stem).filter(Boolean).join(' '));
    const hash = createHash('sha256').update(document.text.replace(/\s+/g, ' ').trim()).digest();
    insertMessage.run(rowid, hash, document.timestamp, document.recency);
  }
  return { corpus, stem, match, count, autoFrequency, appendDocuments, close: () => db.close() };
}
