import { recallPageFromRows } from '../src/locator.mjs';

export function displayRows(rows) {
  return rows.map(({ id, date, role, snippet }) => ({ id, date, role, snippet }));
}

function missingNote(terms, budget) {
  const prefix = '未入索引：';
  const selected = [];
  const suffix = n => n ? `（省略 ${n} 个）` : '';
  const render = words => prefix + words.join('、') + suffix(terms.length - words.length);
  for (const term of terms.slice(0, 10)) {
    const points = Array.from(term);
    const word = points.length > 40 ? points.slice(0, 40).join('') + '…' : term;
    const proposed = [...selected, word];
    if (Array.from(render(proposed)).length > Math.min(512, budget)) break;
    selected.push(word);
  }
  const note = render(selected);
  return Array.from(note).length <= Math.min(512, budget) ? note : '';
}

export function sqliteRecallPage(rows, options = {}, missingTerms = []) {
  const projected = displayRows(rows);
  if (!missingTerms.length) return recallPageFromRows(projected, options);
  let limit = options.limit ?? 50;
  for (; ;) {
    const page = recallPageFromRows(projected, { ...options, limit });
    const remaining = 16000 - Array.from(page.text).length - 1;
    const note = missingNote(missingTerms, remaining);
    if (note) {
      const newline = page.text.indexOf('\n');
      page.text = page.text.slice(0, newline + 1) + note + '\n' + page.text.slice(newline + 1);
      return page;
    }
    if (page.details.returned > 1) {
      limit = page.details.returned - 1;
    } else {
      // Preserve the mainline oversized-id progress exception; the note adds zero
      // bytes when the metadata row alone exhausts the production soft budget.
      return page;
    }
  }
}
