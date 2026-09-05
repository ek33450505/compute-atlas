// Parity test between the bench's quote-grounding gate (quote.mjs, JS) and
// the shipped pipeline's hand-ported copy (../extract-fields.ts, TS).
//
// WHY THIS EXISTS: the bench's headline PRECISION 90% / RECALL 84% /
// ABSTENTION-ACC 96% numbers (rescore.mjs) are computed against quote.mjs's
// gate, not extract-fields.ts's. If the two drift apart, that P/R stops
// describing the shipped tool while still looking authoritative. This test
// is what makes the duplication safe — run it whenever either file changes.
//
// Until this file existed, only extract-fields.ts (and its own
// extract-fields.test.ts) was in version control; quote.mjs and the bench
// pages/results that back these real-data cases were gitignored.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  quotedMwValues as quotedMwValuesJs,
  quoteVerbatim as quoteVerbatimJs,
  quoteSupportsValue as quoteSupportsValueJs,
} from "./quote.mjs";
import {
  quotedMwValues as quotedMwValuesTs,
  quoteVerbatim as quoteVerbatimTs,
  quoteSupportsValue as quoteSupportsValueTs,
} from "../extract-fields";

// ============================================================================
// Real data: every (quote, pageText, value) triple gpt-oss:20b actually
// returned in the bench run, joined against the cached page text it read.
// This is the richest source of genuine model quotes — including the ones
// that exposed past gate bugs (see quote.mjs's header) — so it is the
// broadest regression net against drift. Deliberately loop-driven rather
// than hand-transcribed: it stays exhaustive as result-gpt-oss_20b.json
// grows, and a new model run doesn't require this file to be edited.
// ============================================================================

interface RealCase {
  facility: string;
  field: string;
  quote: string;
  value: number;
}

// process.cwd() (the repo root Vitest runs from), not import.meta.url — see
// facility-form-state.test.ts's identical note: import.meta.url is unreliable
// under this project's Turbopack-flavored transform pipeline.
const BENCH_DIR = path.resolve(process.cwd(), "scripts/discovery/bench");
const resultFile = JSON.parse(
  readFileSync(path.join(BENCH_DIR, "result-gpt-oss_20b.json"), "utf8")
) as { rows: Array<{ facility: string; field: string; quote: string | null; got: unknown }> };
const pagesFile = JSON.parse(readFileSync(path.join(BENCH_DIR, "pages.json"), "utf8")) as Array<{
  facilityId: string;
  text: string;
}>;
const pageTextByFacility = new Map(pagesFile.map((p) => [p.facilityId, p.text]));

// Dedup by facility+field+quote and coerce `got` to a real number — a few
// rows in this specific result file carry `got` as a numeric STRING (a bench
// harness artifact of how run.mjs records results), which is not a shape the
// real pipeline ever produces (extractField's isValidValueForField requires
// an actual JSON `number`, per the model's grammar-constrained schema). We
// coerce here rather than skip, so this stays "the numeric-value domain the
// pipeline actually uses" (per divergence #2 below) instead of silently
// dropping real quotes.
const seen = new Set<string>();
const realCases: RealCase[] = [];
for (const row of resultFile.rows) {
  if (!row.quote) continue;
  const value = typeof row.got === "number" ? row.got : Number(row.got);
  if (!Number.isFinite(value)) continue;
  const key = `${row.facility}::${row.field}::${row.quote}`;
  if (seen.has(key)) continue;
  seen.add(key);
  if (!pageTextByFacility.has(row.facility)) continue;
  realCases.push({ facility: row.facility, field: row.field, quote: row.quote, value });
}

// A canary, not a magic number: if this collapses toward 0, pages.json or
// result-gpt-oss_20b.json stopped loading and the "real data" section below
// would be silently vacuous (an empty loop passes trivially).
it("loaded a meaningful number of real (quote, pageText, value) triples from the bench artifacts", () => {
  expect(realCases.length).toBeGreaterThan(20);
});

describe("real data: quote.mjs vs extract-fields.ts parity across every real model quote", () => {
  for (const { facility, field, quote, value } of realCases) {
    it(`${facility}/${field} — ${JSON.stringify(quote.slice(0, 60))}`, () => {
      const pageText = pageTextByFacility.get(facility)!;

      expect(quotedMwValuesJs(quote)).toEqual(quotedMwValuesTs(quote));

      const verbatimJs = quoteVerbatimJs(quote, pageText);
      const verbatimTs = quoteVerbatimTs(quote, pageText);
      expect(Boolean(verbatimJs)).toBe(verbatimTs);

      const supportsJs = quoteSupportsValueJs(quote, value, pageText);
      const supportsTs = quoteSupportsValueTs(quote, value, pageText);
      expect(Boolean(supportsJs)).toBe(supportsTs);
    });
  }
});

// ============================================================================
// Documented, INTENTIONAL divergences — encoded as expectations, not bugs.
// See the dispatch/README: these are measured, deliberate differences and
// must never be "fixed" into agreement.
// ============================================================================

describe("documented divergences (do not fix)", () => {
  it("divergence #1: on empty/absent input, quote.mjs returns null where extract-fields.ts returns false (both falsy)", () => {
    const page = "Total capacity is rated at 540 MW for phase one.";

    expect(quoteVerbatimJs(null, page)).toBeNull();
    expect(quoteVerbatimTs(null, page)).toBe(false);
    expect(Boolean(quoteVerbatimJs(null, page))).toBe(quoteVerbatimTs(null, page));

    expect(quoteVerbatimJs("", page)).toBeNull();
    expect(quoteVerbatimTs("", page)).toBe(false);

    expect(quoteSupportsValueJs(null, 540, page)).toBeNull();
    expect(quoteSupportsValueTs(null, 540, page)).toBe(false);
    expect(Boolean(quoteSupportsValueJs(null, 540, page))).toBe(quoteSupportsValueTs(null, 540, page));
  });

  it("divergence #2: quote.mjs coerces a numeric-string value; extract-fields.ts's type requires an actual number (unreachable in production)", () => {
    const page = "Total capacity is rated at 540 MW for phase one.";
    // quote.mjs is untyped JS: `Number(String(value).replace(/[^\d.]/g, ""))`
    // happily coerces a string. The real pipeline never calls either
    // implementation with a string (extractField's isValidValueForField
    // enforces `typeof value === "number"` upstream of both gates), and
    // extract-fields.ts's signature is `number | null | undefined` — so we
    // intentionally do not call the TS side with a string here; there is no
    // TS behavior to assert parity against. This case documents why the
    // real-data loop above always coerces to a genuine number first.
    expect(quoteSupportsValueJs("540 MW", "540", page)).toBe(true);
  });
});

// ============================================================================
// Curated edge cases — each previously broke something for real (see
// quote.mjs's and extract-fields.ts's header comments). These assert the
// INTENDED BEHAVIOUR on both sides individually, not just that JS and TS
// agree — two implementations can agree and both be wrong.
// ============================================================================

describe("curated edge cases: intended behaviour, asserted on both implementations", () => {
  it("accepts a sentence-STITCHED quote (two real, non-adjacent sentences joined) — a strict substring rule wrongly rejected this", () => {
    // Mirrors extract-fields.test.ts's canonical stitching case.
    const page =
      "The Ellendale campus reached commercial operation in March 2025. Unrelated filler text about zoning approvals goes here. It draws power from a dedicated 345 kV substation nearby.";
    const stitchedQuote =
      "The Ellendale campus reached commercial operation in March 2025. It draws power from a dedicated 345 kV substation nearby.";

    expect(quoteVerbatimJs(stitchedQuote, page)).toBe(true);
    expect(quoteVerbatimTs(stitchedQuote, page)).toBe(true);
  });

  it("accepts a quote joined by the windowText ' […] ' window separator", () => {
    // windowText (fetch-pages.mjs / extract-fields.ts's Stage 3) joins
    // non-adjacent windows with "\n […] \n"; a model-returned quote that
    // spans two such windows carries that separator verbatim.
    const page =
      "Phase one of the Panther Creek campus secured 350 MW of contracted firm power. " +
      "Several paragraphs of unrelated permitting history sit between the two windows here. " +
      "A second filing confirms the site now totals 500 acres under lease.";
    const joinedQuote =
      "Phase one of the Panther Creek campus secured 350 MW of contracted firm power. \n […] \n A second filing confirms the site now totals 500 acres under lease.";

    expect(quoteVerbatimJs(joinedQuote, page)).toBe(true);
    expect(quoteVerbatimTs(joinedQuote, page)).toBe(true);
  });

  it("accepts a model-emitted quote wrapped in literal backslash-quote marks: \"\\\"540 MW\\\"\"", () => {
    // Real case: aligned-project-caprock-hale-county-tx / capacityMw.planned.
    const page = pageTextByFacility.get("aligned-project-caprock-hale-county-tx")!;
    const wrappedQuote = '"540 MW"';

    expect(quoteVerbatimJs(wrappedQuote, page)).toBe(true);
    expect(quoteVerbatimTs(wrappedQuote, page)).toBe(true);
    expect(quoteSupportsValueJs(wrappedQuote, 540, page)).toBe(true);
    expect(quoteSupportsValueTs(wrappedQuote, 540, page)).toBe(true);
  });

  it("accepts page text carrying undecoded HTML entities (&#160; &#8217; &#8211;) INSIDE the matched span, plus curly punctuation around it", () => {
    // The &#160; (nbsp) sits directly between "540" and "MW" -- inside the
    // character range the quote must match -- so this case is mutation-
    // sensitive: an un-decoded entity here breaks the substring match (its
    // digits survive the alphanumeric collapse and get inserted as a stray
    // token), unlike an entity merely adjacent to, but outside, the matched
    // span.
    const page =
      "The campus" + String.fromCharCode(8217) + "s press kit states " + String.fromCharCode(8220) + "Project scope: 540&#160;MW of contracted capacity" + String.fromCharCode(8221) + " &#8211; effective immediately, per the company&#8217;s filing.";
    const quote = "Project scope: 540 MW of contracted capacity";

    expect(quoteVerbatimJs(quote, page)).toBe(true);
    expect(quoteVerbatimTs(quote, page)).toBe(true);
    expect(quoteSupportsValueJs(quote, 540, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 540, page)).toBe(true);
  });

  it('accepts "Capacity 1,000 kW" for value 1 (kW -> MW conversion, thousand separator)', () => {
    // Real case: ark-data-centers-akron-i-summit-county-oh. A >=20-char rule
    // rejected this 17-char span outright; softNorm (not the alnum collapse)
    // is what keeps the comma-separated "1,000" intact for the regex.
    const page = pageTextByFacility.get("ark-data-centers-akron-i-summit-county-oh")!;
    const quote = "Capacity 1,000 kW";

    expect(quoteVerbatimJs(quote, page)).toBe(true);
    expect(quoteVerbatimTs(quote, page)).toBe(true);
    expect(quoteSupportsValueJs(quote, 1, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 1, page)).toBe(true);
  });

  it('accepts "~48 MW" for value 48 (short-but-real quote)', () => {
    // Real case: crane-pdx02-forest-grove-or. A >=3-token/>=12-char rule
    // measured killing 16 correct values (incl. this one) to block 1 bad one.
    const page = pageTextByFacility.get("crane-pdx02-forest-grove-or")!;
    const quote = "~48 MW";

    expect(quoteVerbatimJs(quote, page)).toBe(true);
    expect(quoteVerbatimTs(quote, page)).toBe(true);
    expect(quoteSupportsValueJs(quote, 48, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 48, page)).toBe(true);
  });

  it('accepts "1GW+" for value 1000 (GW -> MW conversion; the value cannot appear literally in the quote)', () => {
    // Real case: tract-altoona-ia. quoteSupportsValue cannot just check that
    // `value` appears in the quote text — the quote reads "1GW+", never "1000".
    const page = pageTextByFacility.get("tract-altoona-ia")!;
    const quote = "1GW+";

    expect(quoteVerbatimJs(quote, page)).toBe(true);
    expect(quoteVerbatimTs(quote, page)).toBe(true);
    expect(quoteSupportsValueJs(quote, 1000, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 1000, page)).toBe(true);
  });

  it('rejects a bare "60" — a real span of the page, but zero evidential content', () => {
    // Real case: bitfarms-panther-creek-nesquehoning-pa / capacityOperational.
    // The gate exists precisely to block this: a real span is necessary but
    // not sufficient — it must also carry a number+unit that reconciles.
    const page = pageTextByFacility.get("bitfarms-panther-creek-nesquehoning-pa")!;
    const quote = "60";

    expect(quoteVerbatimJs(quote, page)).toBe(true);
    expect(quoteVerbatimTs(quote, page)).toBe(true);
    expect(quoteSupportsValueJs(quote, 60, page)).toBe(false);
    expect(quoteSupportsValueTs(quote, 60, page)).toBe(false);
  });

  it("rejects a fabricated span that appears nowhere on the page", () => {
    // Mirrors extract-fields.test.ts's canonical fabrication case.
    const page = "Total capacity is rated at 540 MW for phase one.";
    const fabricated = "total capacity is rated at 9999 MW";

    expect(quoteVerbatimJs(fabricated, page)).toBeFalsy();
    expect(quoteVerbatimTs(fabricated, page)).toBe(false);
  });

  it("accepts a line-wrapped quote (newlines where the page has them)", () => {
    // Mirrors extract-fields.test.ts's canonical line-wrap case.
    const page = "The facility has a total capacity\nof 540 MW once fully built.";
    const quote = "total capacity of 540 MW";

    expect(quoteVerbatimJs(quote, page)).toBe(true);
    expect(quoteVerbatimTs(quote, page)).toBe(true);
  });

  it('accepts "36‑megawatt" (U+2011 non-breaking hyphen) as a grounded 36 MW value', () => {
    // Real case: flexential-hillsboro-5-or / capacityMw.operational. The page
    // states "...358,000-square-foot, 36‑megawatt, two‑story facility"
    // using U+2011 (non-breaking hyphen), not ASCII '-'. This was measured as
    // breaking both implementations until the dash-class fix.
    const page = pageTextByFacility.get("flexential-hillsboro-5-or")!;
    const quote = "Hillsboro 5, at 4975 NE Starr Blvd., is a 358,000-square-foot, 36‑megawatt, two‑story facility.";

    expect(quoteVerbatimJs(quote, page)).toBe(true);
    expect(quoteVerbatimTs(quote, page)).toBe(true);
    expect(quotedMwValuesJs(quote)).toEqual([36]);
    expect(quotedMwValuesTs(quote)).toEqual([36]);
    expect(quoteSupportsValueJs(quote, 36, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 36, page)).toBe(true);
  });

  // Comprehensive separator coverage — each matcher independently, not just "JS==TS"
  it('matches U+2010 (hyphen) separator with number+unit', () => {
    const page = 'The facility has a 36‐megawatt capacity with no other mentions';
    const quote = 'The facility has a 36‐megawatt capacity';
    expect(quotedMwValuesJs(quote)).toEqual([36]);
    expect(quotedMwValuesTs(quote)).toEqual([36]);
    expect(quoteSupportsValueJs(quote, 36, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 36, page)).toBe(true);
  });

  it('matches U+2011 (non-breaking hyphen) separator with number+unit', () => {
    const page = 'The facility has a 36‑megawatt capacity with no other mentions';
    const quote = 'The facility has a 36‑megawatt capacity';
    expect(quotedMwValuesJs(quote)).toEqual([36]);
    expect(quotedMwValuesTs(quote)).toEqual([36]);
    expect(quoteSupportsValueJs(quote, 36, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 36, page)).toBe(true);
  });

  it('matches U+2012 (figure dash) separator with number+unit', () => {
    const page = 'The facility has a 36‒megawatt capacity with no other mentions';
    const quote = 'The facility has a 36‒megawatt capacity';
    expect(quotedMwValuesJs(quote)).toEqual([36]);
    expect(quotedMwValuesTs(quote)).toEqual([36]);
    expect(quoteSupportsValueJs(quote, 36, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 36, page)).toBe(true);
  });

  it('matches U+2013 (en dash) separator with number+unit', () => {
    const page = 'The facility has a 36–megawatt capacity with no other mentions';
    const quote = 'The facility has a 36–megawatt capacity';
    expect(quotedMwValuesJs(quote)).toEqual([36]);
    expect(quotedMwValuesTs(quote)).toEqual([36]);
    expect(quoteSupportsValueJs(quote, 36, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 36, page)).toBe(true);
  });

  it('matches U+2014 (em dash) separator with number+unit', () => {
    const page = 'The facility has a 36—megawatt capacity with no other mentions';
    const quote = 'The facility has a 36—megawatt capacity';
    expect(quotedMwValuesJs(quote)).toEqual([36]);
    expect(quotedMwValuesTs(quote)).toEqual([36]);
    expect(quoteSupportsValueJs(quote, 36, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 36, page)).toBe(true);
  });

  it('matches U+2015 (horizontal bar) separator with number+unit', () => {
    const page = 'The facility has a 36―megawatt capacity with no other mentions';
    const quote = 'The facility has a 36―megawatt capacity';
    expect(quotedMwValuesJs(quote)).toEqual([36]);
    expect(quotedMwValuesTs(quote)).toEqual([36]);
    expect(quoteSupportsValueJs(quote, 36, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 36, page)).toBe(true);
  });

  it('matches U+2212 (minus sign) separator with number+unit', () => {
    const page = 'The facility has a 36−megawatt capacity with no other mentions';
    const quote = 'The facility has a 36−megawatt capacity';
    expect(quotedMwValuesJs(quote)).toEqual([36]);
    expect(quotedMwValuesTs(quote)).toEqual([36]);
    expect(quoteSupportsValueJs(quote, 36, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 36, page)).toBe(true);
  });

  it('matches U+00AD (soft hyphen) separator with number+unit', () => {
    // Newly-covered gap (Pd fix): U+00AD sits outside the \p{Pd} category
    // (it's Cf, format) so it must stay an explicit addition alongside the
    // category escape, not something \p{Pd} picks up automatically.
    const page = 'The facility has a 36­megawatt capacity with no other mentions';
    const quote = 'The facility has a 36­megawatt capacity';
    expect(quotedMwValuesJs(quote)).toEqual([36]);
    expect(quotedMwValuesTs(quote)).toEqual([36]);
    expect(quoteSupportsValueJs(quote, 36, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 36, page)).toBe(true);
  });

  it('matches U+FF0D (fullwidth hyphen-minus) separator with number+unit', () => {
    // Newly-covered gap: U+FF0D IS inside \p{Pd} (verified empirically), so
    // this is picked up by the category escape alone with no explicit
    // addition needed — unlike U+00AD/U+2212/U+2043 above/below.
    const page = 'The facility has a 36－megawatt capacity with no other mentions';
    const quote = 'The facility has a 36－megawatt capacity';
    expect(quotedMwValuesJs(quote)).toEqual([36]);
    expect(quotedMwValuesTs(quote)).toEqual([36]);
    expect(quoteSupportsValueJs(quote, 36, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 36, page)).toBe(true);
  });

  it('matches U+2043 (hyphen bullet) separator with number+unit', () => {
    // Newly-covered gap: U+2043 sits outside \p{Pd} (category Po, not Pd) —
    // easy to miss since it "looks like" a dash-punctuation character. Must
    // stay an explicit addition.
    const page = 'The facility has a 36⁃megawatt capacity with no other mentions';
    const quote = 'The facility has a 36⁃megawatt capacity';
    expect(quotedMwValuesJs(quote)).toEqual([36]);
    expect(quotedMwValuesTs(quote)).toEqual([36]);
    expect(quoteSupportsValueJs(quote, 36, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 36, page)).toBe(true);
  });

  it('continues to match ASCII hyphen (control case)', () => {
    const page = 'The facility has a 36-megawatt capacity with no other mentions';
    const quote = 'The facility has a 36-megawatt capacity';
    expect(quotedMwValuesJs(quote)).toEqual([36]);
    expect(quotedMwValuesTs(quote)).toEqual([36]);
    expect(quoteSupportsValueJs(quote, 36, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 36, page)).toBe(true);
  });

  it('continues to match space separator (control case)', () => {
    const page = 'The facility has a 36 megawatt capacity with no other mentions';
    const quote = 'The facility has a 36 megawatt capacity';
    expect(quotedMwValuesJs(quote)).toEqual([36]);
    expect(quotedMwValuesTs(quote)).toEqual([36]);
    expect(quoteSupportsValueJs(quote, 36, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 36, page)).toBe(true);
  });

  it('continues to match NBSP U+00A0 separator (control case)', () => {
    const page = 'The facility has a 36 megawatt capacity with no other mentions'; // U+00A0 after 36
    const quote = 'The facility has a 36 megawatt capacity';
    expect(quotedMwValuesJs(quote)).toEqual([36]);
    expect(quotedMwValuesTs(quote)).toEqual([36]);
    expect(quoteSupportsValueJs(quote, 36, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 36, page)).toBe(true);
  });

  it('continues to match narrow NBSP U+202F separator (control case)', () => {
    const page = 'The facility has a 36 megawatt capacity with no other mentions'; // U+202F after 36
    const quote = 'The facility has a 36 megawatt capacity';
    expect(quotedMwValuesJs(quote)).toEqual([36]);
    expect(quotedMwValuesTs(quote)).toEqual([36]);
    expect(quoteSupportsValueJs(quote, 36, page)).toBe(true);
    expect(quoteSupportsValueTs(quote, 36, page)).toBe(true);
  });

  it('rejects bare number with no unit', () => {
    const quote = 'The facility has 36 units';
    expect(quotedMwValuesJs(quote)).toEqual([]);
    expect(quotedMwValuesTs(quote)).toEqual([]);
    expect(quoteSupportsValueJs(quote, 36, 'dummy text 36')).toBe(false);
    expect(quoteSupportsValueTs(quote, 36, 'dummy text 36')).toBe(false);
  });
});

// ============================================================================
// Property test: the dash class must be CATEGORY-based, not enumerated.
//
// This is the test that makes the fix durable. It does not assert against a
// hand-picked list of separators (that would just be more enumeration one
// level up, and would keep passing even if someone reverted the class to a
// curated list that happened to include the same picks). It asks node's own
// `u`-mode regex engine which code points its \p{Pd} (dash punctuation)
// GENERAL CATEGORY contains right now, and requires every single one of them
// to work as a number+unit separator. Derived live rather than hardcoded on
// purpose: it stays coupled to whatever \p{Pd} the runtime defines, so this
// test keeps validating "the class is category-based" even across a future
// Unicode Character Database update that adds or removes a Pd member — a
// hardcoded list would silently stop testing the real category the moment it
// drifted from it.
//
// Proxy check: this test WOULD FAIL against the old enumerated class
// ("[-‐-―−]") for all but a handful of these code points —
// e.g. U+058A (Armenian hyphen), U+1400 (Canadian syllabics hyphen), U+301C
// (wave dash) are real \p{Pd} members the enumeration never anticipated. See
// this file's closing report for the full old-vs-new comparison.
// ============================================================================

function discoverPdCodePoints(): number[] {
  const points: number[] = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // surrogate range, invalid alone
    if (/\p{Pd}/u.test(String.fromCodePoint(cp))) points.push(cp);
  }
  return points;
}

describe("property: every live \\p{Pd} code point matches 36<sep>megawatt", () => {
  const pdCodePoints = discoverPdCodePoints();

  // Canary: an empty/near-empty list would make the loop below vacuous —
  // it would pass trivially while testing nothing (same shape as the
  // "loaded a meaningful number of real triples" canary above).
  it("discovered a non-trivial \\p{Pd} population from the runtime", () => {
    expect(pdCodePoints.length).toBeGreaterThan(20);
  });

  for (const cp of pdCodePoints) {
    const sep = String.fromCodePoint(cp);
    const label = `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    it(`matches with ${label} as the number-unit separator (both implementations)`, () => {
      const quote = `36${sep}megawatt`;
      expect(quotedMwValuesJs(quote)).toEqual([36]);
      expect(quotedMwValuesTs(quote)).toEqual([36]);
    });
  }
});
