// Value copy of ec16440 src/locator.mjs. Only automatic queries filter it.
export const STOPWORDS = new Set((
  'a an and are as at be been but by can could did do does for from had has have how i if in is it its me my of on or our please so than that the their them then there these they this to us was we were what when where which who why will with would you your ' +
  'please tell help about find show recall remember previous earlier history ' +
  '我们 你们 他们 这个 那个 什么 怎么 为什么 可以 是否 之前 然后 以及 还有 一个 帮我 告诉 记得'
).split(/\s+/));
const PURE_HAN = /^\p{Script=Han}+$/u;
// The released, measured analyzer uses Han bigrams without dictionary/ICU terms.

export function tokenizeSpans(text) {
  const spans = [];
  let previousEnd = 0, base = 0;
  for (const match of text.matchAll(/\p{Script=Han}+|[A-Za-z0-9_$]+/gu)) {
    const word = match[0];
    base += Array.from(text.slice(previousEnd, match.index)).length;
    if (!PURE_HAN.test(word)) {
      const components = word.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').split(/[_$\s]+/);
      let at = 0;
      for (const part of components) {
        const index = word.indexOf(part, at);
        at = index + part.length;
        const term = part.toLowerCase();
        if (term.length >= 2) spans.push({ term, start: base + index, end: base + index + part.length });
      }
      base += word.length;
    } else {
      const chars = Array.from(word), pieces = [];
      for (let i = 0; i + 1 < chars.length; i++) pieces.push({ term: chars[i] + chars[i + 1], start: base + i, end: base + i + 2 });
      spans.push(...pieces);
      base += chars.length;
    }
    previousEnd = match.index + word.length;
  }
  return spans;
}

export function tokenize(text) {
  return tokenizeSpans(text).map(span => span.term);
}
