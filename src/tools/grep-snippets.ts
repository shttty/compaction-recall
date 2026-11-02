import { SNIPPET } from "../history/history.mjs";
import { codePointLength, codePointSlice } from "./unicode.ts";

export function grepSnippet(text: string, start: number, end: number, total: number, budget: number): { text: string; visible: { start: number; end: number }[] } {
  let context = SNIPPET;
  let before = codePointSlice(text, Math.max(0, start - context), Math.min(context, start));
  let after = codePointSlice(text, end, Math.min(context, total - end));
  if (end - start + codePointLength(before) + codePointLength(after) <= budget) {
    return {
      text: (before + codePointSlice(text, start, end - start) + after).replace(/\s+/g, " "),
      visible: [{ start: Math.max(0, start - context), end: Math.min(total, end + context) }],
    };
  }

  context = 32;
  before = codePointSlice(text, Math.max(0, start - context), Math.min(context, start));
  after = codePointSlice(text, end, Math.min(context, total - end));
  const marker = "[snippet clipped]";
  const matchBudget = Math.max(0, budget - codePointLength(before) - codePointLength(after) - codePointLength(marker) - 4);
  const first = Math.ceil(matchBudget / 2);
  const last = Math.floor(matchBudget / 2);
  const tailStart = Math.max(start, end - last);
  return {
    text: `${before}…${codePointSlice(text, start, first)}${marker}${codePointSlice(text, tailStart, last)}…${after}`.replace(/\s+/g, " "),
    visible: [
      { start: Math.max(0, start - context), end: Math.min(total, start + first) },
      { start: tailStart, end: Math.min(total, end + context) },
    ],
  };
}
export function unchangedSourceRanges(text: string, ranges: { start: number; end: number }[]): { start: number; end: number; includeStart: boolean; includeEnd: boolean }[] {
  const unchanged: { start: number; end: number; includeStart: boolean; includeEnd: boolean }[] = [];
  for (const range of ranges) {
    const segment = codePointSlice(text, range.start, range.end - range.start);
    let utf16 = 0;
    let points = 0;
    let unchangedStart = range.start;
    let includeStart = true;
    const advance = (target: number) => {
      while (utf16 < target) {
        const code = segment.codePointAt(utf16)!;
        utf16 += code > 0xffff ? 2 : 1;
        points++;
      }
    };
    for (const match of segment.matchAll(/\s+/g)) {
      const index = match.index ?? 0;
      advance(index);
      const transformedStart = range.start + points;
      for (const _point of match[0]) points++;
      utf16 = index + match[0].length;
      if (match[0] === " ") continue;
      if (transformedStart > unchangedStart) {
        unchanged.push({ start: unchangedStart, end: transformedStart, includeStart, includeEnd: false });
      }
      unchangedStart = range.start + points;
      includeStart = false;
    }
    if (unchangedStart < range.end) {
      unchanged.push({ start: unchangedStart, end: range.end, includeStart, includeEnd: true });
    }
  }
  return unchanged;
}
