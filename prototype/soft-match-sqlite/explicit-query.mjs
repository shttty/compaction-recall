// SQLite parses first against an empty same-schema FTS5 table. This scanner
// only rejects native-valid implicit AND; it neither repairs nor compiles SQL.
export function requireExplicitOperators(query, nativeParse, check) {
  check?.();
  nativeParse.get(query); // Preserve SQLite's original error for malformed syntax.
  check?.();
  // FTS5's native query parser stops at NUL; the actual MATCH still gets query.
  const nul = query.indexOf('\0');
  const text = nul < 0 ? query : query.slice(0, nul);
  const tokens = text.match(/"(?:[^"]|"")*"|[A-Za-z0-9_\x1a\u0080-\u{10ffff}]+|[^\s]/gu) ?? [];
  let atom = false;
  const operand = () => {
    if (atom) throw new SyntaxError('Implicit AND is not allowed. Use explicit AND/OR/NOT between operands, or double quotes for an indexed-token phrase.');
    atom = true;
  };
  for (let i = 0; i < tokens.length; i++) {
    check?.();
    const token = tokens[i];
    if (token === '{') { while (tokens[++i] !== '}') check?.(); continue; }
    if (tokens[i + 1] === ':') { i++; continue; } // Native column filter prefix.
    if (token === 'NEAR' && tokens[i + 1] === '(') {
      operand();
      let depth = 1;
      for (i += 2; depth; i++) {
        check?.();
        if (tokens[i] === '(') depth++;
        else if (tokens[i] === ')') depth--;
      }
      i--; // NEAR's parameter spaces and + phrases are owned by SQLite.
    } else if (['AND', 'OR', 'NOT', '+', '('].includes(token)) atom = false;
    else if (token === ')') atom = true;
    else if (token.startsWith('"') || /^[A-Za-z0-9_\x1a\u0080-\u{10ffff}]/u.test(token)) operand();
    // *, ^, :, - are native phrase/filter punctuation, not new operands.
  }
}
