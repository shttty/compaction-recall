// Generated once with Node stripTypeScriptTypes from unchanged author query.ts.
// Source SHA256: ee35b838e82db1f4a2fc559565f86f6ee4c0ace9ad5a887f526c9390084df914
/** Model-facing lexical query. No SQL or FTS5 syntax is accepted. */









/**
 * Backend-only positive expansion: OR of branches, AND of atoms in each branch.
 * Every atom must represent one indexed FTS term under the configured tokenizer.
 * Do not pass index-time expansions as one AND branch without considering meaning.
 */











const LIMITS = Object.freeze({
  groups: 5,
  alternatives: 8,
  exclusions: 5,
  surfaceCodePoints: 256,
  totalSurfaceCodePoints: 2048,
  expansionBranches: 4,
  branchAtoms: 16,
  atomCodePoints: 4096,
  expandedAtoms: 256,
  matchCodeUnits: 32768,
});

class QueryError extends Error {
           code        ;
  constructor(code        , message        ) {
    super(message);
    this.name = "QueryError";
    this.code = code;
  }
}

function fail(code        , message        )        {
  throw new QueryError(code, message);
}

function text(value         , path        , max        )         {
  if (typeof value !== "string") fail("INVALID_TEXT", `${path}: expected a string`);
  // Bound allocations before counting Unicode code points.
  if (value.length > max * 2) fail("LIMIT_EXCEEDED", `${path}: text is too long`);
  for (const ch of value) {
    const cp = ch.codePointAt(0) ;
    if (cp >= 0xd800 && cp <= 0xdfff) {
      fail("INVALID_TEXT", `${path}: unpaired UTF-16 surrogate`);
    }
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
    fail("INVALID_TEXT", `${path}: unsupported control character`);
  }
  const result = value.trim();
  if (!result) fail("EMPTY_TEXT", `${path}: empty text`);
  if ([...result].length > max) fail("LIMIT_EXCEEDED", `${path}: text is too long`);
  return result;
}

function array(value         , path        , min        , max        , clamped              )            {
  if (!Array.isArray(value) || value.length < min || (value.length > max && !clamped)) {
    fail("INVALID_ARRAY", `${path}: expected ${min}..${max} items`);
  }
  // Array.from turns sparse holes into undefined, which subsequent validation rejects.
  const items = Array.from(value);
  if (items.length <= max) return items;
  clamped.push({ path, max, ignored: items.slice(max) });
  return items.slice(0, max);
}

function unique   (values              )      {
  return [...new Set(values)];
}

function join(op              , values                   )         {
  const parts = unique(values);
  if (parts.length === 0) fail("EMPTY_ANALYSIS", "Cannot compile an empty expression");
  return parts.length === 1 ? parts[0]  : `(${parts.join(` ${op} `)})`;
}

/** FTS5 expression quoting, not SQL quoting. */
function quoteFts5Atom(value        )         {
  const atom = text(value, "atom", LIMITS.atomCodePoints);
  return `"${atom.replace(/"/g, '""')}"`;
}

/**
 * Validate unknown tool input, including unknown fields. Count limits fail unless `clamped` is given: then the items past
 * each limit are dropped and recorded there ({ path, max, ignored }) for the caller to report. Nothing is dropped silently.
 */
export function parseQuery(input         , { clamped }                                  = {})                        {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("INVALID_QUERY", "Expected a query object");
  }
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) {
    fail("INVALID_QUERY", "Expected a plain query object");
  }
  const q = input                           ;
  const allowed = new Set(["concepts", "match", "exclude"]);
  for (const key of Object.keys(q)) {
    if (!allowed.has(key)) fail("UNKNOWN_FIELD", `Unknown query field: ${key}`);
  }
  const mode = q.match === undefined ? "any" : q.match;
  if (mode !== "any" && mode !== "all") fail("INVALID_MODE", "match must be any or all");
  let total = 0;
  const surface = (value         , path        )         => {
    const s = text(value, path, LIMITS.surfaceCodePoints);
    total += [...s].length;
    if (total > LIMITS.totalSurfaceCodePoints) {
      fail("LIMIT_EXCEEDED", "Total surface text is too long");
    }
    return s;
  };
  const concepts = array(q.concepts, "concepts", 1, LIMITS.groups, clamped).map((group, i) =>
    unique(array(group, `concepts[${i}]`, 1, LIMITS.alternatives, clamped).map((s, j) =>
      surface(s, `concepts[${i}][${j}]`))),
  );
  const exclude = unique(array(q.exclude === undefined ? [] : q.exclude,
    "exclude", 0, LIMITS.exclusions, clamped).map((s, i) => surface(s, `exclude[${i}]`)));
  return { concepts, match: mode, exclude };
}

/**
 * Pure compilation when analyze is deterministic. No DB access, rewriting,
 * automatic fallback, language-model calls, stemming or synonym inference here.
 */
export function compileFts5(input         , analyze              )                {
  const q = parseQuery(input);
  if (typeof analyze !== "function") fail("MISSING_ANALYZER", "A query analyzer is required");
  let atoms = 0;
  const cache = new Map                ();
  const compileSurface = (surface        )         => {
    const cached = cache.get(surface);
    if (cached !== undefined) return cached;
    let analysis         ;
    try {
      analysis = analyze(surface);
    } catch {
      fail("ANALYZER_FAILED", "The configured query analyzer failed");
    }
    if (Array.isArray(analysis) && analysis.length === 0) {
      fail("EMPTY_ANALYSIS", "A surface form produced no searchable terms");
    }
    const branches = array(analysis, "analysis", 1, LIMITS.expansionBranches).map(branch => {
      const terms = array(branch, "analysis branch", 1, LIMITS.branchAtoms).map(term => {
        if (++atoms > LIMITS.expandedAtoms) fail("LIMIT_EXCEEDED", "Too many expanded atoms");
        const raw = text(term, "analyzed atom", LIMITS.atomCodePoints);
        // Analyzer terms are exact index terms: do not silently trim them.
        if (raw !== term) fail("INVALID_ANALYSIS", "An index atom has outer whitespace");
        return quoteFts5Atom(raw);
      });
      return join("AND", terms);
    });
    const expression = join("OR", branches);
    cache.set(surface, expression);
    return expression;
  };
  const groups = unique(q.concepts.map(group => join("OR", group.map(compileSurface))));
  const positive = join(q.match === "all" ? "AND" : "OR", groups);
  const negative = q.exclude.map(compileSurface);
  const match = negative.length ? `(${positive} NOT ${join("OR", negative)})` : positive;
  if (match.length > LIMITS.matchCodeUnits) fail("LIMIT_EXCEEDED", "Compiled MATCH is too long");
  return { match, groups, mode: q.match };
}
