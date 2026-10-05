import { recallPageFromRows } from '../src/locator.mjs';

export function displayRows(rows) {
  return rows.map(row => ({ id: row.id, date: row.date, role: row.role, get snippet() { return row.snippet; } }));
}

export function sqliteRecallPage(rows, options = {}, bounds) {
  const page = recallPageFromRows(displayRows(rows), options, undefined, bounds);
  if (page.details.total === 0) {
    const newline = page.text.indexOf('\n');
    page.text = page.text.slice(0, newline + 1) +
      '未找到匹配项。请检查概念分组、any/all 匹配方式及词面表达；必要时改写概念或使用 history_grep。零命中不代表历史中不存在相关内容。\n' +
      page.text.slice(newline + 1);
  }
  return page;
}
