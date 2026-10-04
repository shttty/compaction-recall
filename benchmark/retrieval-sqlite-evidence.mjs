import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { loadEvaluationCases } from './retrieval-eval-core.mjs';
import { STOPWORDS } from '../prototype/soft-match-sqlite/lexical.mjs';
import { createTokenizer, validateArm } from '../prototype/soft-match-sqlite/arms.mjs';
import { createStemmer } from '../prototype/soft-match-sqlite/porter.mjs';
import { createJsStemmer } from '../prototype/soft-match-sqlite/porter-js.mjs';
import { createLemmaNormalizer } from '../prototype/soft-match-sqlite/lemma.mjs';

if (isMainThread) {
  const { values } = parseArgs({ options: Object.fromEntries(['arm', 'data', 'gold', 'baseline', 'directory', 'output'].map(name => [name, { type: 'string' }])) });
  for (const name of ['data', 'gold', 'baseline', 'directory', 'output']) if (!values[name]) throw new Error(`Explicit --${name} required`);
  const baseline = JSON.parse(readFileSync(values.baseline, 'utf8'));
  const cases = loadEvaluationCases({ dataRoot: values.data, goldPath: values.gold });
  const evidence = [];
  for (const arm of values.arm ? [validateArm(values.arm)] : ['prefix-all', 'prefix-min4', 'jieba', 'porter']) {
    const run = JSON.parse(readFileSync(`${values.directory}/group1-s6-${arm}.json`, 'utf8'));
    const changes = run.comparison.filter(row => row.mrrDelta !== 0).sort((a, b) => Math.abs(b.mrrDelta) - Math.abs(a.mrrDelta));
    // Keep the largest positive/negative examples within each language, not only winners.
    const selected = new Map();
    for (const lang of ['en', 'zh']) {
      for (const sign of [1, -1]) for (const row of changes.filter(row => row.language === lang && Math.sign(row.mrrDelta) === sign).slice(0, 2)) selected.set(`${row.key}:${lang}`, row);
    }
    if (['inflect-wink', 'lemma-index'].includes(arm)) for (const row of run.comparison.filter(row => row.language === 'en' &&
      ['gpt4_15e38248', '2ce6a0f2', 'gpt4_731e37d7', '9d25d4e0', 'gpt4_65aabe59', '28dc39ac'].includes(row.key.split('/')[1]))) {
      selected.set(`${row.key}:en`, row);
    }
    for (const change of selected.values()) {
      const item = cases.find(row => row.key === change.key && row.language === change.language);
      const old = baseline.rows.find(row => row.key === change.key && row.language === change.language);
      const current = run.rows.find(row => row.key === change.key && row.language === change.language);
      const firstGold = ranking => { const rank = ranking.findIndex(row => item.goldIds.includes(row.id)); return rank < 0 ? null : { rank: rank + 1, ...ranking[rank] }; };
      const oldGold = firstGold(old.results), newGold = firstGold(current.results);
      const oldRanks = new Map(old.results.map((row, i) => [row.id, i + 1]));
      const overtakers = oldGold && newGold ? current.results.slice(0, newGold.rank - 1)
        .filter(row => (oldRanks.get(row.id) ?? Infinity) >= oldGold.rank).slice(0, 3) : [];
      const ids = new Set([...old.results.slice(0, 3), ...current.results.slice(0, 3), ...overtakers, oldGold, newGold].filter(Boolean).map(row => row.id));
      const documents = item.documents.filter(row => ids.has(row.id));
      const inflectionExpansions = run.automaticExpansions?.find(row => row.key === item.key && row.language === item.language)?.expansions;
      const worker = new Worker(new URL(import.meta.url), { workerData: { arm, question: item.question, documents, inflectionExpansions }, execArgv: [] });
      let features;
      try { features = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); worker.once('exit', code => { if (code) reject(new Error(`Evidence worker exited ${code}`)); }); }); }
      finally { await worker.terminate(); }
      evidence.push({
        arm, ...change, question: item.question, firstGoldBefore: oldGold, firstGoldAfter: newGold,
        beforeTotal: old.results.length, afterTotal: current.results.length,
        candidates: documents.map(doc => ({
          id: doc.id, gold: item.goldIds.includes(doc.id),
          rankBefore: old.results.findIndex(row => row.id === doc.id) + 1 || null,
          rankAfter: current.results.findIndex(row => row.id === doc.id) + 1 || null,
          text: doc.text, ...features.documents.find(row => row.id === doc.id)
        })),
        queryTermsBefore: features.queryTermsBefore, queryTermsAfter: features.queryTermsAfter,
        removedQueryTerms: features.queryTermsBefore.filter(term => !features.queryTermsAfter.includes(term))
      });
    }
  }
  writeFileSync(values.output, JSON.stringify({ note: 'Observed full rankings plus actual lexical/prefix/native-stem term evidence; no model calls, no causal guesses about individual BM25 contributions.', evidence }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(evidence.map(row => ({ arm: row.arm, key: row.key, language: row.language, before: row.firstGoldBefore?.rank, after: row.firstGoldAfter?.rank, delta: row.mrrDelta, removed: row.removedQueryTerms }))));
} else {
  const { arm, question, documents, inflectionExpansions } = workerData;
  const old = createTokenizer('off'), current = createTokenizer(arm);
  const lemma = arm === 'lemma-index' ? createLemmaNormalizer() : undefined;
  const queryTermsBefore = [...new Set(old.tokenize(question).filter(term => !STOPWORDS.has(term)))];
  const queryTermsAfter = [...new Set(current.tokenize(question).filter(term => !STOPWORDS.has(term)).map(term => lemma ? lemma.normalize(term) : term))];
  const db = arm === 'porter' ? new DatabaseSync(':memory:') : undefined;
  const stem = db ? createStemmer(db) : arm === 'porter-js' ? createJsStemmer() : undefined;
  try {
    parentPort.postMessage({
      queryTermsBefore, queryTermsAfter, documents: documents.map(doc => {
        const oldTerms = old.tokenize(doc.text), newTerms = current.tokenize(doc.text).map(term => lemma ? lemma.normalize(term) : term);
        const unique = [...new Set(newTerms)];
        const expansions = [];
        for (const query of queryTermsAfter) for (const term of unique) {
          if (term === query) continue;
          const prefix = arm === 'prefix-all' || (arm === 'prefix-min4' && /^[A-Za-z0-9_]{4,}$/.test(query));
          if (prefix && term.startsWith(query)) expansions.push({ query, term, kind: 'prefix' });
          if (stem && stem(query) && stem(query) === stem(term)) expansions.push({ query, term, kind: 'porter', stem: stem(query) });
          if (inflectionExpansions?.find(row => row.term === query)?.variants.includes(term)) expansions.push({ query, term, kind: 'inflection' });
        }
        const stemTokens = stem ? newTerms.flatMap(term => stem(term)?.split(' ') ?? []) : [];
        return {
          id: doc.id, tokenCountBefore: oldTerms.length, tokenCountAfter: newTerms.length + stemTokens.length,
          originalTokenCountAfter: newTerms.length, stemTokenCountAfter: stemTokens.length,
          ...(lemma ? {
            lemmaChanges: [...new Set(oldTerms)].filter(term => lemma.normalize(term) !== term).map(term =>
            ({ original: term, lemma: lemma.normalize(term), queryMatch: queryTermsAfter.includes(lemma.normalize(term)) }))
          } : {}),
          exactMatchesBefore: queryTermsBefore.filter(term => oldTerms.includes(term)),
          exactMatchesAfter: queryTermsAfter.filter(term => newTerms.includes(term)),
          expansions: expansions.slice(0, 50), addedTokens: [...new Set(newTerms)].filter(term => !oldTerms.includes(term)).slice(0, 50),
          removedTokens: [...new Set(oldTerms)].filter(term => !newTerms.includes(term)).slice(0, 50)
        };
      })
    });
  } finally { db?.close(); }
}
