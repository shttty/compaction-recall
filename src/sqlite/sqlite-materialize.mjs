import { selectFts5Range } from './fts5-snippet.mjs';

export function createMaterializer({ corpus, stem, tokenizeSpans, budget, measured }) {
  function compileOperands(operands, check) {
    const raw = new Map(), stems = new Map(), widths = new Set(), cache = new Map();
    const add = (map, term, index) => {
      if (!map.has(term)) map.set(term, []);
      map.get(term).push(index);
    };
    for (let i = 0; i < operands.length; i++) {
      check?.();
      const operand = operands[i];
      add(raw, operand.term, i);
      const alias = operand.stem ? stem(operand.term) : operand.term;
      if (alias === undefined) continue;
      add(stems, alias, i); widths.add(alias.split(' ').length);
    }
    return value => {
      if (cache.has(value)) return cache.get(value);
      const matched = new Set(raw.get(value));
      const alias = stem(value);
      if (alias !== undefined) {
        const pieces = alias.split(' ');
        for (const width of widths) for (let at = 0; at + width <= pieces.length; at++) {
          const key = width === 1 ? pieces[at] : pieces.slice(at, at + width).join(' ');
          for (const i of stems.get(key) ?? []) matched.add(i);
        }
      }
      const terms = [...matched].sort((a, b) => a - b).map(i => operands[i].term);
      cache.set(value, terms);
      return terms;
    };
  }
  function materialize(native, snippetTerms, timer, check) {
    let snippetMatch;
    const results = measured(timer, 'candidate_materialization', () => native.map(({ rowid, score }) => {
        const document = corpus[rowid - 1];
      let rendered;
      return {
        id: document.id, score, date: document.date ?? '', role: document.role ?? 'user',
        get snippet() {
            check?.();
          if (rendered !== undefined) return rendered;
          const hits = measured(timer, 'snippet_hits', () => {
            snippetMatch ??= compileOperands(snippetTerms, check);
            document.spans ??= tokenizeSpans(document.text);
            const found = [];
        for (let at = 0; at < document.spans.length; at++) {
          if ((at & 255) === 0) check?.();
          const span = document.spans[at];
              for (const term of snippetMatch(span.term)) found.push({ ...span, term });
      }
            return found;
    });
          const range = measured(timer, 'snippet_selection', () => {
            document.chars ??= Array.from(document.text);
            return selectFts5Range(document.chars, hits, budget, { sentenceBonus: false, check, weighted: true });
    });
          rendered = measured(timer, 'snippet_render', () => `${range.start > 0 ? '…' : ''}${document.chars.slice(range.start, range.end).join('')}${range.end < document.chars.length ? '…' : ''}`);
      check?.();
          return rendered;
        },
      };
    }));
    check?.();
    return results;
  }
  return materialize;
}
