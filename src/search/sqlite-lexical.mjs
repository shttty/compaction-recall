// Value copy of ec16440 src/locator.mjs. Only automatic queries filter it.
export const STOPWORDS = new Set((
  'a an and are as at be been but by can could did do does for from had has have how i if in is it its me my of on or our please so than that the their them then there these they this to us was we were what when where which who why will with would you your ' +
  'please tell help about find show recall remember previous earlier history ' +
  '我们 你们 他们 这个 那个 什么 怎么 为什么 可以 是否 之前 然后 以及 还有 一个 帮我 告诉 记得'
).split(/\s+/));
// Han and kana runs have no spaces, so both share one adjacent-bigram stream; other letters, numbers and marks
// form whole words. Callers pass NFKC text, so halfwidth kana and fullwidth digits/dots arrive already folded.
const BIGRAM = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u30fc`;
const WORD = String.raw`[[\p{L}\p{N}\p{M}_$]--[${BIGRAM}]]+`;
const RUN = new RegExp(String.raw`[${BIGRAM}]+|${WORD}(?:\.${WORD})*`, 'gv');
export const BIGRAM_TERM = new RegExp(String.raw`^[${BIGRAM}]+$`, 'v');

function wordSpans(word, base, spans) {
  const components = word.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').split(/[_$\s]+/);
  let at = 0;
  for (const part of components) {
    const index = word.indexOf(part, at);
    at = index + part.length;
    const length = Array.from(part).length;
    if (length < 2) continue;
    const start = base + Array.from(word.slice(0, index)).length;
    spans.push({ term: part.toLowerCase(), start, end: start + length });
  }
}

export function tokenizeSpans(text) {
  const spans = [];
  let previousEnd = 0, base = 0;
  for (const match of text.matchAll(RUN)) {
    const run = match[0], chars = Array.from(run);
    base += Array.from(text.slice(previousEnd, match.index)).length;
    if (BIGRAM_TERM.test(run)) {
      for (let i = 0; i + 1 < chars.length; i++) spans.push({ term: chars[i] + chars[i + 1], start: base + i, end: base + i + 2 });
    } else {
      let start = base;
      for (const word of run.split('.')) {
        wordSpans(word, start, spans);
        start += Array.from(word).length + 1;
      }
      // Dotted runs (10.0.0.1, v8.0.23, config.py) are also indexed whole; fragments keep partial runs searchable.
      if (run.includes('.')) spans.push({ term: run.toLowerCase(), start: base, end: base + chars.length });
    }
    base += chars.length;
    previousEnd = match.index + run.length;
  }
  return spans;
}

export function tokenize(text) {
  return tokenizeSpans(text).map(span => span.term);
}
