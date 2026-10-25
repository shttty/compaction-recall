import { LOCATOR_HEADER, recallPageFromRows } from '../history/locator.mjs';

export function displayRows(rows) {
  return rows.map(row => ({ id: row.id, date: row.date, role: row.role, get snippet() { return row.snippet; } }));
}

export function sqliteRecallPage(rows, options = {}, bounds) {
  const warnings = bounds?.warnings ?? [];
  const header = LOCATOR_HEADER + (warnings.length ? warnings.join('\n') + '\n' : '');
  const page = recallPageFromRows(displayRows(rows), options, undefined, { ...bounds, header });
  return warnings.length ? { ...page, details: { ...page.details, warnings } } : page;
}
