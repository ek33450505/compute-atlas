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
const D = new URL("./", import.meta.url).pathname;
const TRUTH = JSON.parse(readFileSync(D + "truth.json", "utf8"));
// Grounding is RECOMPUTED here, not trusted from the stored result: the run that
// produced these rows used a gate that certified the 2-char quote "60" as grounded.
// Scoring must be fixable without re-spending a 20-minute model run.
const PAGETEXT = Object.fromEntries(
  JSON.parse(readFileSync(D + "pages.json", "utf8")).map((p) => [p.facilityId, p.text]),
);

const num = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  const m = String(v).match(/-?[\d,.]+/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const close = (a, b) => a !== null && b !== null && Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1) < 0.05;
const pct = (x) => (x === null ? "  n/a" : `${String(Math.round(x * 100)).padStart(3)}%`);

const files = readdirSync(D).filter((x) => x.startsWith("result-") && x.endsWith(".json")).sort();
if (!files.length) { console.log("no result-*.json — run: node run.mjs <model-tag>"); process.exit(0); }

for (const f of files) {
  const R = JSON.parse(readFileSync(D + f, "utf8"));
  const rows = R.rows ?? [];
  let tp = 0, tn = 0, miss = 0, wrong = 0, hall = 0, ambig = 0, errs = 0, ms = 0;
  let qChecked = 0, qGrounded = 0, qUngroundedWithValue = 0;
  const perField = {};
  const detail = [];

  for (const r of rows) {
    ms += r.ms || 0;
    if (r.error) { errs++; continue; }
    r.grounded = quoteGrounded(r.quote, PAGETEXT[r.facility] ?? "");
    // Re-derive the label from truth.json — NEVER trust r.expected, which was frozen
    // into the result file at run time. Reading the stored copy silently ignored every
    // label correction and made "rescore against verified truth" a no-op.
    const tt = TRUTH[r.facility] ?? {};
    const exp = tt[r.field] ?? null;
    r.accept = tt[`accept${r.field[0].toUpperCase()}${r.field.slice(1)}`] ?? null;
    if (exp === "AMBIG") { ambig++; continue; }
    const got = num(r.got);
    const pf = (perField[r.field] ??= { tp: 0, tn: 0, miss: 0, wrong: 0, hall: 0 });

    let v;
    if (exp === null) {
      if (got === null) { v = "abstain-ok"; tn++; pf.tn++; }
      else { v = "HALLUCINATION"; hall++; pf.hall++; }
    } else {
      const accepts = r.accept && r.accept.length ? r.accept : [exp];
      if (got === null) { v = "miss"; miss++; pf.miss++; }
      else if (accepts.some((a) => close(got, a))) { v = "value-ok"; tp++; pf.tp++; }
      else { v = "WRONG"; wrong++; pf.wrong++; }
    }
    if (v !== "value-ok" && v !== "abstain-ok") {
      const why = v === "HALLUCINATION" || v === "WRONG"
        ? `  quote=${JSON.stringify(String(r.quote ?? "").slice(0, 70))} grounded=${r.grounded}`
        : `  reason=${JSON.stringify(String(r.reasonIfNull ?? "").slice(0, 70))}`;
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
  console.log(`${R.model}   ${scored} scored cells (${ambig} AMBIG excluded, ${errs} errors)  avg ${Math.round(ms / (rows.length || 1))}ms`);
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
