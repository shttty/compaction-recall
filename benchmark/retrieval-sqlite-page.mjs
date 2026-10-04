import { recallPageFromRows } from '../src/locator.mjs';

// Keep production pagination and JSON rows; reserve space for the vocabulary note.
export function sqliteRecallPage(rows, options = {}, missingTerms = []) {
  if (!missingTerms.length) return recallPageFromRows(rows, options);
  const note = `未入索引：${missingTerms.join('、')}`;
  let limit = options.limit ?? 50;
  let renderedRows = rows;
  let page;
  for (; ;) {
    page = recallPageFromRows(renderedRows, { ...options, limit });
    const newline = page.text.indexOf('\n');
    page.text = newline < 0 ? page.text + '\n' + note : page.text.slice(0, newline + 1) + note + '\n' + page.text.slice(newline + 1);
    if (Array.from(page.text).length <= 16000) return page;
    if (renderedRows === rows) {
      renderedRows = rows.map(row => ({ ...row, snippet: '' }));
    } else if (page.details.returned > 1) {
      limit = page.details.returned - 1;
    } else {
      // Same oversized-row progress rule: complete metadata/note, never silently lose an id.
      page.details.budgetExceeded = true;
      return page;
    }
  }
}
