#!/usr/bin/env node
// Local-model bench for Compute Atlas's field-extraction lane (field extraction from cited sources).
//
//   node run.mjs <model-tag> [field,field,...]     -> writes result-<model>.json
//   node rescore.mjs                               -> scores every result against truth.json
//
// Scored on REAL cached pages from the live dataset, never synthetic text: the
// hard lesson here is that 268 tests + 3 review passes + 17 killed mutants all cleared a
// tool that failed on its first real page.
//
// Ground truth lives in truth.json, hand-verified by reading context. It is NOT
// derived from the DB record -- a facility's recorded value frequently comes from
// a different source than the page under test.
//
// ── The system prompt is a THREE-WAY CONJUNCTION ──────────────
// Remove any one of these and Tract Altoona's 1GW silently becomes null:
//   1. the GW->MW conversion instruction
//   2. "(quote the ORIGINAL units as written)" -- without it the verbatim-quote
//      requirement SUPPRESSES the conversion, because 1000 cannot appear in a
//      quote reading "1GW+", and the model resolves that conflict by abstaining
//   3. the reasonIfNull field -- forcing the model to justify an abstention turns
//      a lazy null into a correct extraction (measured 0/6 -> 6/6)
// Deterministic: seed changes nothing, this is not sampling noise.

import { readFileSync, writeFileSync } from "node:fs";
// Field-kind map lives in fields.mjs -- shared with rescore.mjs -- so the
// prompt and the scorer can't drift apart. Same rationale as quote.mjs.
import { KIND, FIELD_KINDS, FIELD_ENUM_VALUES } from "./fields.mjs";

const PAGES = JSON.parse(readFileSync(new URL("./pages.json", import.meta.url).pathname, "utf8"));
const TRUTH = JSON.parse(readFileSync(new URL("./truth.json", import.meta.url).pathname, "utf8"));

const MODEL = process.argv[2];
if (!MODEL) { console.error("usage: run.mjs <model-tag> [field,field,...]"); process.exit(1); }

const FIELDS = {
  capacityAny: "total electrical capacity in megawatts for this facility, whether already built or planned",
  capacityPlanned: "PLANNED, designed, entitled, or future electrical capacity in megawatts for this facility",
  capacityOperational: "electrical capacity in megawatts ALREADY BUILT or currently in service at this facility",
  onSiteGenerationMw: "capacity in megawatts of ON-SITE or behind-the-meter POWER GENERATION at this facility (not grid supply, and not standby/backup generators)",
  // coolingType is genuinely ambiguous in this dataset: waterSchema.coolingType
  // (the data-centre cooling system, scored here) and miningSchema.coolingType
  // (a SEPARATE crypto-mining field whose vocabulary includes "immersion" and
  // "hydro") share two values ("air", "hybrid"), so a mining page saying
  // "air-cooled" could wrongly land here and still validate against the
  // vocabulary below. The description below is written to target the
  // data-centre cooling system specifically, not mining rig cooling.
  // The VALUE DEFINITIONS below are not decoration. Measured 2026-09-01 over 69
  // pages: with the bare vocabulary list and no rule, gpt-oss:20b scored
  // P=53% / R=42%, and EIGHT of its twelve error cells were the same case --
  // a page whose true value is `closed_loop`, a recirculating circuit that the
  // operator markets as "air cooling", answered `air`, `hybrid` or null. Only
  // 4 of 12 closed_loop pages were right; with the rule below, 12 of 12 were.
  // That is the exact error a human curator made on edgecore-mesa-az, which is
  // why the rule was written down in docs/methodology.md#cooling-type +
  // lib/schema.ts at all. A model cannot apply a rule it was never given; the
  // definitions here are copied from that methodology section and must not
  // drift from it -- including the "hybrid is not air+liquid" clarification,
  // which was added to the methodology and the schema comment alongside this.
  coolingType:
    "the DATA CENTER FACILITY's cooling system for its IT/electrical load (NOT a crypto-mining rig's " +
    "cooling method -- ignore any 'immersion' or rig-level cooling description). " +
    "Classify BY WATER CONSUMPTION: " +
    "'evaporative' = heat rejected by evaporating water (cooling towers, adiabatic/evaporative assist); " +
    "'hybrid' = the design SWITCHES between evaporative and dry modes (e.g. wet in summer, dry in winter) -- " +
    "it does NOT mean a mix of air and liquid cooling; " +
    "'closed_loop' = a recirculating water/coolant circuit that is not evaporated (chilled-water loop, " +
    "direct-to-chip liquid loop, air-cooled chillers over a closed circuit); " +
    "'air' = NO cooling water circuit at all (dry/direct air cooling, 'waterless', 'zero water for cooling'). " +
    "TIE-BREAKER: if a recirculating water or coolant circuit is present, answer 'closed_loop' EVEN IF the page " +
    "calls the design 'air-cooled' -- operators market closed-loop designs that way, so the phrase does not decide it; " +
    "'air' requires the absence of a cooling water circuit. " +
    `Answer with EXACTLY ONE of these values: ${FIELD_ENUM_VALUES.coolingType.join(", ")} -- or null if not stated for this facility.`,
  energySource:
    "the facility's primary power source category. " +
    `Answer with EXACTLY ONE of these values: ${FIELD_ENUM_VALUES.energySource.join(", ")} -- or null if not stated for this facility.`,
  energyUtility:
    "the name of the electric utility company that supplies, or is contracted to supply, power to this facility, or null if not stated",
};
const RUN_FIELDS = process.argv[3] ? process.argv[3].split(",") : Object.keys(FIELDS);

const SCHEMA = {
  type: "object",
  properties: {
    value: { type: ["number", "string", "null"] },
    verbatimQuote: { type: ["string", "null"] },
    reasonIfNull: { type: ["string", "null"] },
  },
  required: ["value", "verbatimQuote", "reasonIfNull"],
};

// Composed per-field (see sysFor below) so the GW/MW unit-conversion
// guidance -- correct and necessary for the four NUMERIC fields -- is not
// sent for a categorical field, where it would be actively misleading. The
// three SYS_* pieces concatenate to byte-identical text for numeric fields
// (verified against the pre-split SYS string this replaced).
const SYS_BASE =
  "You extract ONE field about ONE named facility from a web page. " +
  "Return the value ONLY if the page explicitly states it FOR THAT SPECIFIC FACILITY. " +
  "If the page does not state it, or states it for a different site/company-wide total, return null. " +
  "Never estimate, never infer, never use outside knowledge. ";
const SYS_UNITS =
  "UNITS: capacity fields are in MEGAWATTS (MW). If the page states capacity in gigawatts (GW), " +
  "convert it and return megawatts: 1 GW = 1000 MW (e.g. '1GW' -> 1000, '2.5 GW' -> 2500). " +
  "Converting a stated unit is not inference; report the converted number. ";
const SYS_TAIL =
  "verbatimQuote must be text copied exactly from the page (quote the ORIGINAL units as written); " +
  "null if value is null. " +
  "If you return null, set reasonIfNull to a one-sentence explanation.";
const sysFor = (field) =>
  (FIELD_KINDS[field] ?? KIND.NUMERIC) === KIND.NUMERIC ? SYS_BASE + SYS_UNITS + SYS_TAIL : SYS_BASE + SYS_TAIL;

// LOOSE quote grounding lives in quote.mjs so rescore.mjs can RECOMPUTE it —
// a gate bug must be fixable without spending another model run.
import { quoteGrounded } from "./quote.mjs";

const rows = [];
let n = 0;
// Denominator counts only cells that will actually run -- PAGES x FIELDS would
// print a progress bar that never reaches its own total once cells are skipped.
const total = PAGES.reduce((acc, p) => {
  const t = TRUTH[p.facilityId];
  return acc + (t ? RUN_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(t, f)).length : 0);
}, 0);

// Skipping an UNLABELED cell is not an optimisation, it is the same guard
// rescore.mjs applies (see its UNLABELED-CELL GUARD): a cell with no label in
// truth.json cannot be scored, so spending a model call on it only produces a
// row the scorer must throw away. Skipped cells are counted and reported at the
// end -- a silent skip would make "the bench ran clean" and "the bench measured
// nothing" look identical, which is how a field ships unmeasured.
const skipped = [];
for (const p of PAGES) {
  const t = TRUTH[p.facilityId];
  if (!t) { console.log(`  (no truth entry) ${p.facilityId}`); continue; }
  for (const field of RUN_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(t, field)) { skipped.push(`${p.facilityId}/${field}`); continue; }
    n++;
    const t0 = Date.now();
    let out = null, err = null;
    try {
      const res = await fetch("http://localhost:11434/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(180000),
        body: JSON.stringify({
          model: MODEL, stream: false, format: SCHEMA,
          options: { temperature: 0, num_ctx: 16384 },
          messages: [
            { role: "system", content: sysFor(field) },
            { role: "user", content:
              `Facility: ${p.name} — ${p.city}, ${p.state}\n` +
              `Field: ${field} — ${FIELDS[field]}\n\nPAGE TEXT:\n${p.text}` },
          ],
        }),
      });
      const j = await res.json();
      const raw = j.message?.content ?? "";
      // gpt-oss returns "" on /api/generate with a schema; assert non-empty so a
      // silent empty string can never be read as an abstention.
      if (!raw.trim()) throw new Error("EMPTY CONTENT");
      out = JSON.parse(raw);
    } catch (e) { err = e.message; }

    const ms = Date.now() - t0;
    const expected = t[field];
    rows.push({
      facility: p.facilityId, field, expected,
      accept: t[`accept${field[0].toUpperCase()}${field.slice(1)}`] ?? null,
      got: out?.value ?? null,
      quote: out?.verbatimQuote ?? null,
      reasonIfNull: out?.reasonIfNull ?? null,
      grounded: err ? null : quoteGrounded(out?.verbatimQuote, p.text),
      error: err, ms,
    });
    process.stdout.write(
      `  [${String(n).padStart(3)}/${total}] ${p.facilityId.slice(0, 34).padEnd(35)} ` +
      `${field.padEnd(20)} exp=${String(expected).padStart(7)} got=${String(out?.value ?? "null").slice(0, 12).padStart(12)}  ${ms}ms\n`);
  }
}

// A PARTIAL run must not clobber a full run's evidence. result-<model>.json is the
// calibration artifact behind the shipped tool's headline P/R numbers (see README);
// re-running with a field subset used to overwrite it in place, silently replacing
// four fields of measurement with one. Subset runs get their own file, and
// rescore.mjs scores every result-*.json, so both keep being reported.
const RESULT_FILE = `result-${MODEL.replace(/[:/]/g, "_")}` +
  (process.argv[3] ? `-${RUN_FIELDS.join("+").replace(/[^A-Za-z0-9+]/g, "")}` : "") + ".json";
writeFileSync(new URL(`./${RESULT_FILE}`, import.meta.url).pathname,
  JSON.stringify({ model: MODEL, fields: RUN_FIELDS, pages: PAGES.length, skipped, rows }, null, 2));
if (skipped.length) {
  const byField = {};
  for (const s2 of skipped) { const f = s2.split("/").pop(); byField[f] = (byField[f] ?? 0) + 1; }
  console.log(`\n  SKIPPED (no truth.json label — NOT measured): ${skipped.length} cells` +
    `\n    ${Object.entries(byField).map(([f, c]) => `${f}: ${c}`).join("  ")}`);
}
console.log(`\nwrote ${RESULT_FILE} — now run: node rescore.mjs`);
