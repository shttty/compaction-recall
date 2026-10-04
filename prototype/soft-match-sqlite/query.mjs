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
    const terms = text.match(/[A-Za-z0-9_$\u0080-\u{10ffff}]+/gu) ?? [];
    return terms.map((term, index) => ({ term: term.toLowerCase(), prefix: prefix && index === terms.length - 1 }));
  });
}

export function queryTerms(query) {
  return [...new Set(queryOperands(query).map(({ term }) => term))];
}

// Add only implicit prefixes. Explicit phrase operators (^, +, *) own their
// operands; column names and NEAR groups are syntax, not expansion candidates.
export function prefixExpression(query, arm, check) {
  if (arm !== 'prefix-all' && arm !== 'prefix-min4') return query;
  const tokens = [...query.matchAll(/"(?:[^"]|"")*"|[A-Za-z0-9_\x1a\u0080-\u{10ffff}]+|[^\s]/gu)];
  // Never complete or otherwise repair an unterminated user phrase.
  if (tokens.some(token => token[0] === '"')) return query;
  const text = i => tokens[i]?.[0];
  let columns = 0;
  let nearDepth = 0;
  let result = '';
  let copied = 0;
  for (let i = 0; i < tokens.length; i++) {
    check?.();
    const word = text(i);
    if (nearDepth) {
      if (word === '(') nearDepth++;
      if (word === ')') nearDepth--;
      continue;
    }
    if (word === 'NEAR' && text(i + 1) === '(') {
      nearDepth = 1;
      i++;
      continue;
    }
    if (word === '{') { columns++; continue; }
    if (word === '}') { columns--; continue; }
    if (columns || text(i + 1) === ':' || ['AND', 'OR', 'NOT'].includes(word)) continue;
    if (['^', '+'].includes(text(i - 1)) || ['+', '*'].includes(text(i + 1))) continue;
    const eligible = arm === 'prefix-min4'
      ? /^[A-Za-z0-9_]{4,}$/.test(word)
      : /^[A-Za-z0-9_\x1a\u0080-\u{10ffff}]+$/u.test(word);
    if (!eligible) continue;
    const end = tokens[i].index + word.length;
    result += query.slice(copied, end) + '*';
    copied = end;
  }
  return result + query.slice(copied);
}
