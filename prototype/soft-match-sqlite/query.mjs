// Parse only operand identities. SQLite remains the authority on MATCH syntax.
// Phrase constituents are terms; SQLite owns their positional semantics.
function operands(query, check) {
  const tokens = String(query).match(/"(?:[^"]|"")*"|[(){}:,^*]|[^\s(){}:,^*]+/gu) ?? [];
  const result = [];
  const scopes = [];
  let columns = false;
  for (let i = 0; i < tokens.length; i++) {
    check?.();
    const token = tokens[i];
    if (token === '{') { columns = true; continue; }
    if (token === '}') { columns = false; continue; }
    if (columns || tokens[i + 1] === ':') continue;
    if (token === '(') { scopes.push(tokens[i - 1] === 'NEAR'); continue; }
    if (token === ')') { scopes.pop(); continue; }
    if (token === ':' || token === ',') continue;
    if (['AND', 'OR', 'NOT'].includes(token) || (token === 'NEAR' && tokens[i + 1] === '(')) continue;
    if (scopes.at(-1) && tokens[i - 1] === ',' && /^\d+$/.test(token)) continue;
    const quoted = token.startsWith('"') && token.endsWith('"') && token.length >= 2;
    const text = quoted ? token.slice(1, -1).replaceAll('""', '"') : token;
    if (!/[A-Za-z0-9_\u0080-\u{10ffff}]/u.test(text)) continue;
    result.push({ text, quoted, prefix: tokens[i + 1] === '*' });
  }
  return result;
}

export function queryOperands(query, check) {
  return operands(query, check).flatMap(({ text, prefix }) => {
    check?.();
    // FTS5 ascii tokenization of MATCH operands: do not re-tokenize Han into bigrams.
    const terms = text.match(/[A-Za-z0-9\u0080-\u{10ffff}]+/gu) ?? [];
    return terms.map((term, index) => ({ term: term.toLowerCase(), prefix: prefix && index === terms.length - 1 }));
  });
}

export function queryTerms(query) {
  return [...new Set(queryOperands(query).map(({ term }) => term))];
}
