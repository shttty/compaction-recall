import { queryOperands } from './query.mjs';

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

export function porterTerm(term, stem, prefix = false) {
  const suffix = prefix ? '*' : '';
  const base = quote(term) + suffix;
  const alias = stem(term);
  if (!alias) return `tokens : ${base}`;
  if (alias === term) return `{tokens stems} : ${base}`;
  // Different aliases are separate native phrases: their BM25 evidence adds.
  return `(tokens : ${base} OR stems : ${quote(alias)}${suffix})`;
}

// Rewrite complete native phrase/NEAR units, never operator names, column
// names, or NEAR distances. Explicit column filters are native escape hatches.
export function porterExpression(query, stem, check) {
  const tokens = [];
  for (const match of query.matchAll(/"(?:[^"]|"")*"|[A-Za-z0-9_\x1a\u0080-\uffff]+|[^ \t\r\n]/g)) {
    check?.();
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  if (tokens.some(token => token.text === '"')) return { expression: query, operands: queryOperands(query, check) };
  const replacements = [], operands = [];
  const text = i => tokens[i]?.text;
  const string = i => tokens[i] && /^["A-Za-z0-9_\x1a\u0080-\uffff]/.test(text(i)) && !['AND', 'OR', 'NOT'].includes(text(i));
  const closes = new Map(), stack = [];
  for (let i = 0; i < tokens.length; i++) {
    check?.();
    if (['(', '{'].includes(text(i))) stack.push(i);
    else if ((text(i) === ')' && text(stack.at(-1)) === '(') || (text(i) === '}' && text(stack.at(-1)) === '{')) closes.set(stack.pop(), i);
  }
  function walk(start, end, columns) {
    for (let i = start; i < end;) {
      check?.();
      let at = i, selected = columns;
      if (text(at) === '-') at++;
      const columnEnd = text(at) === '{' ? closes.get(at) : string(at) ? at : undefined;
      if (columnEnd !== undefined && text(columnEnd + 1) === ':') {
        const names = tokens.slice(at, columnEnd + 1).filter(token => !['{', '}'].includes(token.text)).map(token => token.text.replaceAll('"', ''));
        selected = text(i) === '-' ? ['tokens', 'stems'].filter(name => !names.includes(name)) : names;
        at = columnEnd + 2;
      } else at = i;
      if (text(at) === '(') {
        const close = closes.get(at);
        if (close === undefined) { i++; continue; }
        walk(at + 1, close, selected);
        i = close + 1;
        continue;
      }
      const first = at;
      if (text(at) === '^') at++;
      const near = text(at) === 'NEAR' && text(at + 1) === '(';
      if (near) {
        const close = closes.get(at + 1);
        if (close === undefined) { i++; continue; }
        at = close + 1;
      } else {
        if (!string(at)) { i++; continue; }
        at++;
        if (text(at) === '*') at++;
        while (text(at) === '+' && string(at + 1)) {
          at += 2;
          if (text(at) === '*') at++;
        }
      }
      const unit = query.slice(tokens[first].start, tokens[at - 1].end);
      const pieces = tokens.slice(first, at);
      const quoted = pieces.some(token => token.text.startsWith('"'));
      const effective = selected ?? (quoted ? ['tokens'] : ['tokens', 'stems']);
      const unitOperands = queryOperands(unit, check);
      operands.push(...unitOperands.map(operand => ({ ...operand, columns: effective, stem: !selected && !quoted })));
      if (!selected) {
        let rewritten;
        if (quoted) rewritten = `tokens : ${unit}`;
        else if (!near && unitOperands.length === 1 && !unit.includes('+') && !unit.startsWith('^')) {
          const operand = unitOperands[0];
          rewritten = porterTerm(operand.term, stem, operand.prefix);
        } else {
          let offset = tokens[first].start, alias = '', available = true, unchanged = true;
          for (let j = first; j < at; j++) {
            check?.();
            const token = tokens[j];
            if (!string(j) || token.text === 'NEAR' || (text(j - 1) === ',' && /^\d+$/.test(token.text))) continue;
            const value = stem(token.text.toLowerCase());
            if (!value) available = false;
            if (value !== token.text.toLowerCase()) unchanged = false;
            alias += query.slice(offset, token.start) + quote(value ?? token.text);
            offset = token.end;
          }
          alias += query.slice(offset, tokens[at - 1].end);
          rewritten = !available ? `tokens : ${unit}` : unchanged ? `{tokens stems} : ${unit}`
            : `(tokens : ${unit} OR stems : ${alias})`;
        }
        replacements.push({ start: tokens[first].start, end: tokens[at - 1].end, text: rewritten });
      }
      i = at;
    }
  }
  walk(0, tokens.length);
  let expression = '', offset = 0;
  for (const replacement of replacements) {
    check?.();
    expression += query.slice(offset, replacement.start) + replacement.text;
    offset = replacement.end;
  }
  return { expression: expression + query.slice(offset), operands };
}
