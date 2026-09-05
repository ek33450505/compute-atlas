// Quote grounding for the field-extraction lane — shared by run.mjs (records it) and rescore.mjs
// (RECOMPUTES it, so a gate bug is fixable without re-spending a model run).
//
// ── Why this is not a substring test ────────────────────────────────────────
// Three rules were tried and each false-rejected correct answers:
//   1. strict substring        -> broke on line-wrapped sources and on gpt-oss
//                                 STITCHING two real non-adjacent sentences (§2.1)
//   2. >= 20 chars             -> rejected "Capacity 1,000 kW", a real 17-char span
//   3. >= 3 tokens, >= 12 chars-> rejected "10 gigawatts", "~48 MW", "1GW+", "540 MW"
// Rule 3 measured: as a hard gate it killed 16 CORRECT values to block 1 bad one.
//
// The error was treating quote LENGTH as the signal. For numeric field extraction a
// short quote is the NORM -- the evidence for "48 MW" is literally "~48 MW". What
// actually distinguishes evidence from noise is not size but whether the quote
// RECONCILES WITH THE VALUE. So the gate has two independent parts:
//
//   verbatim  - the quote is a real span of the page (blocks fabricated spans)
//   supports  - the quote carries a number + unit that, converted to MW, matches
//               the returned value (blocks a bare "60", which is a real span of any
//               document and evidence for nothing)
//
// Unit conversion is why `supports` cannot just check that the value appears in the
// quote: the value is 1000 and the quote correctly reads "1GW+".
//
// ⚠️ KNOWN LIMIT, measured: this cannot catch a REAL figure assigned to the WRONG
// FIELD -- "…358,000-square-foot, 36-megawatt…" is genuine evidence for 36 MW of
// capacity and reconciles perfectly, even when the model returned it as
// onSiteGenerationMw. Mechanical grounding bounds fabrication, never semantics.
// That gap is what human review is for; do not let a green gate imply otherwise.

// ⚠️ NORMALISATION IS THE WHOLE BALLGAME. Under whitespace+lowercase
// only, the verbatim check killed 10 of 26 CORRECT extractions. Not one was a
// fabrication: the model wraps quotes in literal \" marks ("\"540 MW\"",
// "\"1.4 gigawatts\"") and the page carries undecoded HTML entities (&#8217;, &#160;,
// &#8211;) and curly punctuation. Collapsing both sides to alphanumerics-and-spaces
// takes correct-kept from 16/26 to 25/26 while blocking exactly as much fabrication.
// Punctuation-sensitivity was masquerading as a grounding failure.
const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/&#\d+;|&[a-z]+;/g, " ") // undecoded HTML entities
    .replace(/[^a-z0-9]+/g, " ")      // punctuation, quote marks, dashes, NBSP
    .trim();

/** Whitespace-only normalisation, for pulling number+unit pairs out of a quote. */
const softNorm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const UNIT_MW = { kw: 0.001, kilowatt: 0.001, kilowatts: 0.001, mw: 1, megawatt: 1, megawatts: 1, gw: 1000, gigawatt: 1000, gigawatts: 1000 };

// Separator that can join a number to its unit in compound-adjective prose
// ("36-megawatt"). A real page (bench corpus, flexential-hillsboro-5-or) wrote
// this with U+2011 NON-BREAKING HYPHEN ("36‑megawatt"), not ASCII '-', and
// en/em dashes ("36–megawatt") are ordinary published-prose punctuation, not
// exotic — an ASCII-only `-?` silently missed all of them, turning a real,
// grounded quote into zero MW values.
//
// An earlier version of this class enumerated code points
// (U+2010-U+2015, U+2212). Enumeration is itself the defect: every separator
// nobody thought of becomes another silent false absence — three more were
// found by inspection (U+00AD soft hyphen, U+FF0D fullwidth hyphen-minus,
// U+2043 hyphen bullet). Replaced with `\p{Pd}`, Unicode's dash-punctuation
// GENERAL CATEGORY, which is exhaustive by construction (27 code points as of
// Unicode's current release, empirically enumerated with `\p{Pd}` under the
// `u` flag — verified in node, NOT trusted from a written list) and already
// covers U+2010-U+2015 and U+FF0D. Two of the three newly-found separators
// sit OUTSIDE `Pd` under their real Unicode category and must stay explicit
// additions: U+2212 (minus sign, category Sm) and U+00AD (soft hyphen,
// category Cf) — confirmed by category lookup, not assumption. The third,
// U+2043 (hyphen bullet), is ALSO outside `Pd` (category Po, punctuation-
// other) and is easy to miss if you stop at "the two symbol/format
// categories" — it must stay explicit too. Requires the `u` flag on every
// regex that embeds this class (bare `\p{...}` is literal `p` without it).
// Kept to a SINGLE optional character (not a wildcard span) on purpose:
// prose where a dash is ordinary clause punctuation rather than a
// compound-adjective joiner (e.g. "$36 — MW capacity unknown") still
// requires the unit token immediately after it to match — considered and
// rejected as a broadening risk. Shared (not redefined) at extract-fields.ts's
// NUM_UNIT_DASH_CLASS, so both regexes stay in lockstep —
// quote-parity.test.ts fails loudly if only one is fixed.
const DASH_CLASS = "[\\p{Pd}\\u2212\\u00AD\\u2043]";
const NUM_UNIT = new RegExp(
  `(\\d[\\d,.]*)\\s*${DASH_CLASS}?\\s*(kw|kilowatts?|mw|megawatts?|gw|gigawatts?)\\b`,
  "giu"
);

/** Every number in `quote` that carries a power unit, expressed in MW. */
export function quotedMwValues(quote) {
  const out = [];
  // softNorm here, NOT norm: the alnum collapse would split "1,000 kW" into
  // "1 000 kw" and destroy the number the reconciliation depends on.
  for (const m of softNorm(quote).matchAll(NUM_UNIT)) {
    const n = Number(m[1].replace(/,/g, ""));
    const mult = UNIT_MW[m[2].toLowerCase()];
    if (Number.isFinite(n) && mult) out.push(n * mult);
  }
  return out;
}

/** Is the quote a real span of the page? Allows wrapping and sentence-stitching. */
export function quoteVerbatim(quote, pageText) {
  if (!quote) return null;
  const q = norm(quote);
  if (!q) return null;
  const page = norm(pageText);
  if (page.includes(q)) return true;
  // 🔴 ORDER OF OPERATIONS: split the RAW quote on sentence boundaries, THEN
  // normalise each fragment. Normalising first strips the '.' characters this regex
  // needs, collapsing every stitched quote into a single fragment that can never
  // match — silently disabling the stitching allowance that is the whole reason
  // fragment-matching exists (gpt-oss demonstrably stitches two real non-adjacent
  // sentences, §2.1). I introduced exactly that bug by switching `norm` to the alnum
  // collapse and not re-running this module's test; a dispatched agent's test caught it.
  const frags = String(quote)
    .split(/(?<=[.!?;])\s+|\s+\[…\]\s+/)
    .map(norm)
    .filter((f) => f.length >= 15);
  return frags.length > 0 && frags.every((f) => page.includes(f));
}

/** Does the quote actually evidence `value` (in MW)? */
export function quoteSupportsValue(quote, value, pageText) {
  if (!quote || value === null || value === undefined) return null;
  if (!quoteVerbatim(quote, pageText)) return false;
  const v = typeof value === "number" ? value : Number(String(value).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(v)) return false;
  const cands = quotedMwValues(quote);
  if (!cands.length) return false; // e.g. a bare "60": real span, zero evidential content
  return cands.some((c) => Math.abs(c - v) / Math.max(Math.abs(c), Math.abs(v), 1) < 0.05);
}

// Back-compat name used by run.mjs's stored `grounded` column.
export const quoteGrounded = quoteVerbatim;
