#!/usr/bin/env node
// Scores every result-*.json against truth.json.
//
// Reports PRECISION and RECALL separately, not just a single total. The s96 bench
// used one asymmetric score, and that score cannot distinguish "extracts well" from
// "abstains on everything" without help -- granite4:32b scored joint-best on
// hallucination rate purely by returning null 100% of the time (0/6 recall).
//
// Definitions (per scored cell, AMBIG cells excluded):
//   truth=value, got=value, matches   -> TP  correct extraction
//   truth=value, got=value, different -> FP  WRONG VALUE   (worst: a lie with a citation)
//   truth=value, got=null             -> FN  miss          (merely a gap)
//   truth=null,  got=value            -> FP  HALLUCINATION (worst: invents a fact)
//   truth=null,  got=null             -> TN  correct abstention
//
//   recall    = TP / (TP + miss + wrong)     of stated values, how many we got right
//   precision = TP / (TP + wrong + halluc)   of values returned, how many were right
//   abstAcc   = TN / (TN + halluc)           of unstated fields, how often we stayed silent
//   score     = TP + TN - 2*(wrong + halluc) asymmetric: fabrication costs double
//
// A dataset whose whole promise is "every fact traceable to a real source" should
// prefer a gap to a fabrication, so precision and abstention accuracy outrank recall.

import { readFileSync, readdirSync } from "node:fs";
import { quoteGrounded } from "./quote.mjs";
// Field-kind map lives in fields.mjs -- shared with run.mjs -- so the
// scorer can't drift from what was actually asked. Same rationale as the
// quote.mjs split (see that file's header): the gate must be fixable
// without re-spending a model run.
import {
  KIND, fieldKind, FIELD_ENUM_VALUES,
  normalizeEnum, normalizeText, isInVocabulary,
  numericValue, numericClose,
} from "./fields.mjs";
const D = new URL("./", import.meta.url).pathname;
const TRUTH = JSON.parse(readFileSync(D + "truth.json", "utf8"));
// Grounding is RECOMPUTED here, not trusted from the stored result: the run that
// produced these rows used a gate that certified the 2-char quote "60" as grounded.
// Scoring must be fixable without re-spending a 20-minute model run.
const PAGETEXT = Object.fromEntries(
  JSON.parse(readFileSync(D + "pages.json", "utf8")).map((p) => [p.facilityId, p.text]),
);

const pct = (x) => (x === null ? "  n/a" : `${String(Math.round(x * 100)).padStart(3)}%`);

// Kind-dispatched extraction/comparison. NUMERIC routes through
// numericValue()/numericClose() -- moved to fields.mjs verbatim from this
// file's former local num()/close(), unchanged -- see rescore-BASELINE
// regression requirement (numeric scoring must stay byte-identical).
// ENUM/TEXT route through fields.mjs's normalisers.
//
// IMPORTANT for ENUM: an out-of-vocabulary answer must normalise to a
// non-null string (never coerced to null the way numericValue() coerces an
// unparseable string) -- otherwise it would be silently miscounted as a
// "miss" instead of the WRONG it actually is. normalizeEnum already has
// this property: it only returns null for a genuinely null/undefined/empty
// input, never for a value merely outside the declared vocabulary.
const extractGot = (kind, raw) => {
  if (kind === KIND.ENUM) return normalizeEnum(raw);
  if (kind === KIND.TEXT) return normalizeText(raw);
  return numericValue(raw);
};
const valuesEqual = (kind, got, exp) => {
  if (kind === KIND.ENUM) return got === normalizeEnum(exp);
  if (kind === KIND.TEXT) return got === normalizeText(exp);
  return numericClose(got, exp);
};

// UNLABELED-CELL GUARD (do not remove — see the block below for why).
//
// truth.json's lookup is `TRUTH[facility] ?? {}` followed by `tt[field] ?? null`.
// A MISSING LABEL therefore collapses to exp === null — which is *indistinguishable*
// from a genuine "the page states nothing, correctly expect null" abstention label.
// Downstream, exp === null + a model value is scored HALLUCINATION. So scoring a
// cell that was never labeled reports the model's correct extractions as
// hallucinations: silence reads as data, and the resulting precision number means
// nothing.
//
// The guard is per CELL, not per facility, because a missing FIELD is the live
// case now. All 69 facilities are labeled, but the 38 pages added for the
// coolingType corpus carry a coolingType label ONLY — running the four numeric
// fields over them would score every correct capacity as a hallucination. The
// same hole already existed for energySource/energyUtility, which no page has
// ever been labeled for even though both fields ship in the nightly pipeline.
//
// A field counts as labeled only if the key is PRESENT on the entry; a genuine
// "expect nothing" label is written as an explicit `null`. Absent means unmeasured,
// which fails toward under-reporting coverage rather than inventing a verdict.
//
// truth.json also carries documentation-only top-level keys (e.g. "_README",
// an array of strings) that are NOT facility labels. Only a key whose value is
// a non-null, non-array OBJECT counts as a real label entry.
const isLabelEntry = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasLabel = (facility, field) =>
  isLabelEntry(TRUTH[facility]) && Object.prototype.hasOwnProperty.call(TRUTH[facility], field);

const files = readdirSync(D).filter((x) => x.startsWith("result-") && x.endsWith(".json")).sort();
if (!files.length) { console.log("no result-*.json — run: node run.mjs <model-tag>"); process.exit(0); }

for (const f of files) {
  const R = JSON.parse(readFileSync(D + f, "utf8"));
  const rows = R.rows ?? [];
  let tp = 0, tn = 0, miss = 0, wrong = 0, hall = 0, ambig = 0, errs = 0, ms = 0;
  let qChecked = 0, qGrounded = 0, qUngroundedWithValue = 0;
  const perField = {};
  const detail = [];
  const unlabeledFacilities = new Set();
  const unlabeledFields = new Set();
  let unlabeledCells = 0;

  for (const r of rows) {
    ms += r.ms || 0;
    if (r.error) { errs++; continue; }
    // No label for this facility+field — exclude entirely rather than let it
    // silently fall through as expect-null (see guard comment above the files
    // loop). Never counted as tn/hallucination/miss/anything.
    if (!hasLabel(r.facility, r.field)) {
      unlabeledFacilities.add(r.facility);
      unlabeledFields.add(r.field);
      unlabeledCells++;
      continue;
    }
    r.grounded = quoteGrounded(r.quote, PAGETEXT[r.facility] ?? "");
    // Re-derive the label from truth.json — NEVER trust r.expected, which was frozen
    // into the result file at run time. Reading the stored copy silently ignored every
    // label correction and made "rescore against verified truth" a no-op.
    const tt = TRUTH[r.facility] ?? {};
    const exp = tt[r.field] ?? null;
    r.accept = tt[`accept${r.field[0].toUpperCase()}${r.field.slice(1)}`] ?? null;
    if (exp === "AMBIG") { ambig++; continue; }
    const kind = fieldKind(r.field);
    const got = extractGot(kind, r.got);
    const pf = (perField[r.field] ??= { tp: 0, tn: 0, miss: 0, wrong: 0, hall: 0 });

    let v;
    if (exp === null) {
      if (got === null) { v = "abstain-ok"; tn++; pf.tn++; }
      else { v = "HALLUCINATION"; hall++; pf.hall++; }
    } else {
      const accepts = r.accept && r.accept.length ? r.accept : [exp];
      if (got === null) { v = "miss"; miss++; pf.miss++; }
      else if (accepts.some((a) => valuesEqual(kind, got, a))) { v = "value-ok"; tp++; pf.tp++; }
      else { v = "WRONG"; wrong++; pf.wrong++; }
    }
    if (v !== "value-ok" && v !== "abstain-ok") {
      let why = v === "HALLUCINATION" || v === "WRONG"
        ? `  quote=${JSON.stringify(String(r.quote ?? "").slice(0, 70))} grounded=${r.grounded}`
        : `  reason=${JSON.stringify(String(r.reasonIfNull ?? "").slice(0, 70))}`;
      // ENUM-only: flag an out-of-vocabulary answer explicitly. It's already
      // scored WRONG above (never silently downgraded to a miss -- see
      // extractGot's comment) -- this just makes the reason legible, since
      // an out-of-vocab value is a real defect the extractor would then try
      // to write into a Zod enum field.
      if (kind === KIND.ENUM && v === "WRONG" && got !== null && !isInVocabulary(got, FIELD_ENUM_VALUES[r.field])) {
        why += `  OUT-OF-VOCABULARY`;
      }
      detail.push(`${v.padEnd(14)} ${r.facility}/${r.field} exp=${exp} got=${r.got}${why}`);
    }
    if (r.quote) {
      qChecked++;
      if (r.grounded) qGrounded++;
      else if (got !== null) qUngroundedWithValue++;
    }
  }

  const scored = tp + tn + miss + wrong + hall;
  const recall = tp + miss + wrong ? tp / (tp + miss + wrong) : null;
  const precision = tp + wrong + hall ? tp / (tp + wrong + hall) : null;
  const abstAcc = tn + hall ? tn / (tn + hall) : null;
  const score = tp + tn - 2 * (wrong + hall);

  console.log(`\n${"=".repeat(94)}`);
  // Name the FILE, not just the model: subset runs mean several result files can
  // carry the same model tag, and two identically-headed blocks are unreadable.
  console.log(`${R.model}  [${f}]   ${scored} scored cells (${ambig} AMBIG excluded, ${errs} errors)  avg ${Math.round(ms / (rows.length || 1))}ms`);
  // Loud and separate from the scoring section below — these facilities were NOT
  // measured (no truth.json label to measure against), not measured-and-fine.
  // Worded so a reader skimming for a pass/fail can't mistake this for either.
  console.log(`  UNLABELED (not scored, NOT measured — no truth.json label): ` +
    `${unlabeledCells} cells excluded across ${unlabeledFacilities.size} facilities` +
    (unlabeledFields.size ? `\n    fields: ${[...unlabeledFields].sort().join(", ")}` : "") +
    (unlabeledFacilities.size ? `\n    ids: ${[...unlabeledFacilities].sort().join(", ")}` : ""));
  console.log(`  PRECISION ${pct(precision)}   RECALL ${pct(recall)}   ABSTENTION-ACC ${pct(abstAcc)}   score ${score}`);
  console.log(`  correct=${tp}  correctAbstain=${tn}  miss=${miss}  WRONG=${wrong}  HALLUC=${hall}`);
  console.log(`  quote-grounded ${qGrounded}/${qChecked}` +
    (qUngroundedWithValue ? `   ⚠ ${qUngroundedWithValue} value(s) returned with an UNGROUNDED quote` : ""));

  console.log(`  per field:`);
  for (const [fname, s] of Object.entries(perField)) {
    const r2 = s.tp + s.miss + s.wrong ? s.tp / (s.tp + s.miss + s.wrong) : null;
    const p2 = s.tp + s.wrong + s.hall ? s.tp / (s.tp + s.wrong + s.hall) : null;
    console.log(`    ${fname.padEnd(21)} P=${pct(p2)} R=${pct(r2)}  ok=${s.tp} abst=${s.tn} miss=${s.miss} WRONG=${s.wrong} HALLUC=${s.hall}`);
  }
  if (detail.length) {
    console.log(`  failures:`);
    detail.forEach((d) => console.log("    " + d));
  }
}
