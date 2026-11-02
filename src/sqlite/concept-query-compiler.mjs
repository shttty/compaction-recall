import { LIMITS, fail, text, array, unique, parseQuery } from '../query/concept-query.mjs';

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
