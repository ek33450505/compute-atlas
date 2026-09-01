/**
 * Track 5 companion tool: CHECKS values already recorded on live facilities
 * against the sources those facilities already cite. `extract-fields.ts`
 * FILLS missing fields; this tool does the opposite and never fills
 * anything — it is read-only with respect to the dataset.
 *
 * WHY THIS EXISTS: 484 facilities carry a `capacityMw` value today (182
 * operational, 341 planned), every one source-backed, and not one has ever
 * been machine-checked against its own cited sources. Those values came from
 * earlier human/agent research waves, not from this pipeline — so an
 * independent model re-reading the same page is a genuine second opinion,
 * not the model grading its own homework. Data correctness outranks facility
 * counts: a wrong recorded value is worse than a missing one, because
 * downstream it is indistinguishable from a verified fact.
 *
 * === THE CENTRAL DESIGN CONSTRAINT ===
 * "The source no longer states a figure" is NOT evidence the record is
 * wrong. It is usually link rot, a paywall, a rewritten page, or a bot-wall.
 * Conflating that with "the value is incorrect" would produce hundreds of
 * false alarms and burn the scarcest resource this project has: human review
 * attention. The ONLY actionable signal is that a source states a DIFFERENT
 * number than the record. Every (facility, field, source) check lands in
 * exactly one of five outcomes, kept strictly separate:
 *   - confirmed     — source states a value matching the record (5% rel. tol.)
 *   - disagreement  — source states a value OUTSIDE tolerance — THE PAYLOAD
 *   - unconfirmed   — page fetched/readable, model returned null (or its
 *                      answer failed the quote gate — see below); the page
 *                      simply doesn't support a claim either way
 *   - noMention     — cheap prefilter found no plausible mention at all
 *   - unreachable   — the source couldn't be fetched, or wasn't legible
 *                      (JS-rendered/empty), or the model call itself failed
 * `unconfirmed` must NEVER be counted as a `disagreement` — that is the
 * single most important invariant in this file. See `verify-fields.test.ts`'s
 * mutation-test coverage for this exact regression.
 *
 * === READ ALL SOURCES — DELIBERATELY THE OPPOSITE OF extract-fields.ts ===
 * `extract-fields.ts` stops the moment a field is filled — correct there,
 * because filling one gap from one good source is the whole job. Here,
 * stopping at the first confirming source would build in confirmation bias:
 * if source 1 confirms and source 3 contradicts, an early exit systematically
 * hides exactly the contradictions this tool exists to find. Every cited
 * source — PDF or HTML alike, since F1 — is read for every field under
 * check, every time. If two
 * sources state different numbers, BOTH are reported — inconsistent sourcing
 * is itself a correctness finding. Do not "optimize" this into an early
 * exit; see the test file's mutation-test note before touching this rule.
 *
 * === THE QUOTE GATE APPLIES TO THE MODEL'S OWN ANSWER ===
 * Before a source-stated value is ever compared to the record, it must pass
 * the same mechanical quote gate `extract-fields.ts` uses on the page it
 * just read (`quoteVerbatim` / `quoteSupportsValue`, reused verbatim from
 * that module). An ungrounded model value raising a false disagreement
 * against a CORRECT recorded value is the worst outcome this tool can
 * produce — worse than finding nothing — so a model answer that fails the
 * gate is downgraded to `unconfirmed`, never allowed to become a
 * `disagreement`.
 *
 * === OUTPUT: A REPORT, NOT CANDIDATES ===
 * This tool NEVER writes live data and NEVER emits a candidates file for
 * `submit-candidates.ts`. A disagreement is a QUESTION, not a proposed
 * correction — the source may describe a different build phase, a later
 * expansion, or a superseded figure. The model is qualified to notice a
 * mismatch; it is not qualified to decide which number is right. Proposing
 * corrections would smuggle model judgement into the dataset through the
 * staging queue, which this project's core invariant (see CLAUDE.md's "no
 * unreviewed write ever becomes a live facility") does not allow even via a
 * side door. `--out <path>` writes a JSON report (this run's full summary,
 * including every per-source result) — nothing this script writes is ever
 * consumed by `submit-candidates.ts`.
 *
 * === REUSE ===
 * Imports `ExtractableField`, `prefilter`, `windowText`, `buildUserPrompt`,
 * `fieldJsonSchema`, `extractField`, `quoteVerbatim`, `quoteSupportsValue`,
 * `ModelExtraction`, `ExtractFieldModelDeps`, `CONSECUTIVE_FETCH_FAILURE_
 * ABORT_THRESHOLD`, and `parseFieldsArg` from `extract-fields.ts` — the
 * model-calling, quote-gating, and windowing machinery is IDENTICAL between
 * the fill tool and this check tool, only what happens after a value comes
 * back differs. F1 also shares that file's PDF-vs-HTML source router:
 * `fetchSourceText`/`FetchState`/`createFetchState`/`SourceFetchDeps` are
 * imported directly rather than mirrored, so this tool's PDF handling can
 * never drift from `extract-fields.ts`'s — see `fetchSourceText`'s
 * doc-comment there for the routing rule itself. A few small helpers
 * `extract-fields.ts` does not export are still mirrored locally with an
 * explicit coupling comment at each definition (`isNumericField`/
 * `NUMERIC_FIELDS`, `RECONCILE_TOLERANCE`, `MIN_READABLE_CHARS`) — keep each
 * in sync with its unexported counterpart in `extract-fields.ts` if that
 * file's constants ever change.
 *
 * === ACCOUNTING ===
 * Every (facility, field, source) triple this tool actually attempts is
 * pushed exactly once into `VerifyFieldsSummary.results`, tagged with one of
 * the five `VerifyOutcome` values above. The five summary counters are
 * tallied from that single array via `OUTCOME_TO_SUMMARY_KEY`, a
 * `Record<VerifyOutcome, ...>` — TypeScript requires an entry for every
 * member of the `VerifyOutcome` union, so a new outcome added without a
 * mapping entry fails `npx tsc --noEmit` instead of silently vanishing from
 * the reconciliation (the same defect-5/6 class `extract-fields.ts` guards
 * against with its own `OUTCOME_TO_SUMMARY_KEY`). Unlike that file, this
 * tool has no early-exit / "still unfilled" state machine, so there is no
 * equivalent "unclassified" sentinel to guard against: every attempted
 * triple is classified exactly once, at the point it is attempted, by
 * construction — the reconciliation identity
 * `confirmed + disagreements + unconfirmed + noMention + unreachable ===
 * results.length === sourceChecksAttempted` holds structurally, not just as
 * an invariant to be separately verified.
 *
 * THIS TRIPLE-LEVEL ACCOUNTING HAS A BLIND SPOT: a value whose facility cites
 * no sources at all, or was never reached because of an abort, contributes
 * ZERO triples — not even an `unreachable` one, since there was nothing to
 * even attempt fetching. (Since F1, a PDF-only facility no longer falls into
 * this blind spot — every cited source, PDF or HTML, is now actually fetched,
 * so it contributes at least one real triple, `unreachable` if the fetch or
 * extraction fails.) Such a value is invisible to the five
 * outcome counters and, without a second layer, indistinguishable in the
 * output from a value that was fully checked. That is the exact shape of the
 * incident that motivated the abort guard below: a balanced-looking report
 * and exit 0 while some part of the dataset was never actually examined —
 * silence read as success. So there is a SECOND, coarser accounting layer,
 * over VALUES rather than triples: every selected (facility, field) value is
 * `valuesChecked` (>=1 triple attempted, any outcome) or `valuesUnchecked`
 * (zero triples — see `UncheckedReason`), and `valuesConsidered =
 * valuesChecked + valuesUnchecked` is asserted the same structural way as the
 * triple-level identity (see `runVerify`'s per-value reconciliation pass —
 * every originally-selected value is independently classified into exactly
 * one of the two buckets, never derived by subtraction). Keep BOTH layers —
 * do not "simplify" `valuesUnchecked` into folding it back into
 * `valuesChecked`, or into a value dropped from the printed summary; either
 * restores the exact blind spot this section exists to close, and is
 * mutation-tested in `verify-fields.test.ts` for precisely that regression.
 *
 * The `CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD` guard (imported from
 * extract-fields.ts) is reused for the same reason it exists there: a
 * verification run that cannot fetch has verified nothing and must not exit
 * 0 looking like a clean "everything confirmed" sweep — silence here is MORE
 * dangerous than in the fill tool, because an empty `disagreements` list
 * reads as "no problems found" rather than "nothing was checked." The streak
 * counter mirrors `extract-fields.ts`'s own distinction between a genuine
 * fetch failure (increments the streak) and a merely-thin/JS-rendered page
 * that DID fetch (resets it, since the network path is proven alive). Since
 * F1, a failed PDF fetch is an ordinary fetch failure like any other and DOES
 * count toward the streak — the old exemption for all-PDF facilities (they
 * were never fetched at all, so could not indicate network health either
 * way) no longer applies now that PDFs are actually fetched.
 *
 * All side-effecting dependencies (fetch, the Ollama call, the clock) are
 * injected via `VerifyFieldsDeps` — `main()` builds the real implementations
 * lazily, and only inside itself, behind the `isMain` guard, so importing
 * this module for tests never opens a socket.
 *
 * Run via:
 *   npx tsx --env-file=.env.local scripts/discovery/verify-fields.ts \
 *     [--out <path>] [--limit N] [--fields capacityMw.planned,energy.source] \
 *     [--facility <id>] [--run-id=ID]
 *   (--out is optional here too, but unlike extract-fields.ts there is no
 *   dry-run/live distinction to gate — this script never writes live data
 *   either way; --out only controls whether the JSON report also lands on
 *   disk, in addition to the human-readable summary always printed)
 *
 * ⚠️ DO NOT RUN THIS LIVE while another Ollama consumer is mid-sweep — a
 * local Ollama instance serializes requests, and two concurrent long-running
 * callers corrupt each other's runs. Coordinate with whoever owns the
 * current sweep before invoking `main()` for real.
 *
 * Uses relative imports throughout — tsx does not resolve the `@/*` path
 * alias, matching the rest of scripts/discovery/.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Facility } from "../../lib/schema";
import {
  CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD,
  EXTRACTABLE_FIELDS,
  atomicWriteJson,
  createFetchState,
  extractField,
  fetchSourceText,
  parseFieldsArg,
  prefilter,
  quoteSupportsValue,
  quoteVerbatim,
  windowText,
  type ExtractFieldModelDeps,
  type ExtractableField,
  type FetchState,
  type ModelExtraction,
  type SourceFetchDeps,
} from "./extract-fields";
import { callOllama } from "./ollama-client";
import { fetchPageText } from "./fetch-page-text";
import { fetchPdfText } from "./fetch-pdf-text";

// Note on reuse: `buildUserPrompt` and `fieldJsonSchema` (also exported by
// extract-fields.ts) are NOT imported here directly — this tool never calls
// the model itself; it calls `extractField`, which already calls both of
// them internally. Importing them here too would just be dead code.

// ============================================================================
// Locally-mirrored constants — NOT exported by extract-fields.ts. Keep each
// in sync with its unexported counterpart there if that file ever changes.
// ============================================================================

// COUPLING: mirrors extract-fields.ts's unexported `NUMERIC_FIELDS`/
// `isNumericField`.
const NUMERIC_FIELDS = new Set<ExtractableField>([
  "capacityMw.planned",
  "capacityMw.operational",
  "energy.onSiteGenerationMw",
]);
function isNumericField(field: ExtractableField): boolean {
  return NUMERIC_FIELDS.has(field);
}

// COUPLING: mirrors extract-fields.ts's unexported `RECONCILE_TOLERANCE`
// (also 0.05) — both files must agree on what counts as "the same fact" so a
// value this tool calls `confirmed` can never simultaneously be treated as a
// meaningful correction by the fill tool's own duplicate-of-sibling guard.
const RECONCILE_TOLERANCE = 0.05;

// COUPLING: mirrors extract-fields.ts's unexported `MIN_READABLE_CHARS`
// (also 400) — a fetch that "succeeds" but returns near-empty text (e.g. a
// JS-rendered page) is not usable evidence either way; see that constant's
// doc-comment in extract-fields.ts for the full rationale.
const MIN_READABLE_CHARS = 400;

// ============================================================================
// Stage 1 — selectValuesToVerify: which (facility, field) pairs currently
// carry a RECORDED value worth checking (the mirror image of
// extract-fields.ts's selectGaps, which selects the currently-UNDEFINED ones)
// ============================================================================

export interface FieldValueCheck {
  facility: Facility;
  field: ExtractableField;
  /** The value currently on record for this field. Guaranteed to match the
   * runtime type `field` implies (number for the three numeric fields,
   * string for `energy.source`/`energy.utility`) by `fieldRecordedValue`'s
   * switch, the same field-tag-guarantees-shape pattern extract-fields.ts
   * itself relies on. */
  recordedValue: number | string;
}

function fieldRecordedValue(facility: Facility, field: ExtractableField): number | string | undefined {
  switch (field) {
    case "capacityMw.planned":
      return facility.capacityMw?.planned;
    case "capacityMw.operational":
      return facility.capacityMw?.operational;
    case "energy.onSiteGenerationMw":
      return facility.energy?.onSiteGenerationMw;
    case "energy.source":
      return facility.energy?.source;
    case "energy.utility":
      return facility.energy?.utility;
  }
}

/** Every (facility, field) pair in `facilities` x `fields` whose target field
 * currently carries a recorded value — the opposite selection from
 * `selectGaps`. Order: outer loop over facilities, inner loop over `fields`
 * in the order given, matching `selectGaps`'s own iteration order. */
export function selectValuesToVerify(facilities: Facility[], fields: ExtractableField[]): FieldValueCheck[] {
  const checks: FieldValueCheck[] = [];
  for (const facility of facilities) {
    for (const field of fields) {
      const recordedValue = fieldRecordedValue(facility, field);
      if (recordedValue !== undefined) {
        checks.push({ facility, field, recordedValue });
      }
    }
  }
  return checks;
}

// ============================================================================
// Reconciliation: does a source-stated value count as "the same fact" as the
// recorded value?
// ============================================================================

/**
 * Numeric fields use the shared 5% relative-tolerance rule (`RECONCILE_
 * TOLERANCE`, mirroring extract-fields.ts). `energy.source`/`energy.utility`
 * use case-insensitive, whitespace-collapsed string equality — intentionally
 * conservative: it will not recognize that "Xcel Energy" and "Xcel Energy
 * Inc." name the same utility, so a string-field `disagreement` is a weaker
 * signal than a numeric one. That's an acceptable trade for this tool: every
 * `disagreement` already carries the verbatim quote and is routed to a human
 * for a few seconds of adjudication, never auto-applied — see the file
 * header's "a disagreement is a QUESTION" rationale.
 */
export function valuesReconcile(field: ExtractableField, recorded: number | string, sourceStated: number | string): boolean {
  if (isNumericField(field)) {
    const r = recorded as number;
    const s = sourceStated as number;
    return Math.abs(r - s) / Math.max(Math.abs(r), Math.abs(s), 1) < RECONCILE_TOLERANCE;
  }
  const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
  return normalize(String(recorded)) === normalize(String(sourceStated));
}

// ============================================================================
// Per-(facility, field, source) classification
// ============================================================================

export type VerifyOutcome = "confirmed" | "disagreement" | "unconfirmed" | "noMention" | "unreachable";

export interface SourceVerification {
  facilityId: string;
  facilityName: string;
  field: ExtractableField;
  recordedValue: number | string;
  sourceUrl: string;
  outcome: VerifyOutcome;
  /** Only set for `confirmed`/`disagreement`, and for an `unconfirmed`
   * result produced by a quote-gate rejection (where the model DID return a
   * value, it just wasn't grounded) — undefined for `noMention` and for a
   * genuine `unreachable`. */
  sourceStatedValue?: number | string | null;
  /** Only set alongside `sourceStatedValue` — the model's own verbatim
   * quote, unconditionally included on confirmed/disagreement results so a
   * human reviewer can adjudicate a disagreement in seconds. */
  verbatimQuote?: string | null;
  /** Human-readable reason, always set for unconfirmed/noMention/unreachable
   * and never set for confirmed/disagreement (the recorded vs. source-stated
   * values already say everything needed there). */
  detail?: string;
}

/**
 * Classifies ONE (facility, field, source) triple against page text already
 * fetched and windowed. Never called for a source that failed to fetch or
 * was too thin to read — those are classified directly by `verifyFacility`
 * without reaching this function, since the outcome (`unreachable`) does not
 * depend on `field` and calling in here would pointlessly window/prefilter
 * unreadable text.
 */
async function classifyReadableSource(
  facility: Facility,
  field: ExtractableField,
  recordedValue: number | string,
  sourceUrl: string,
  pageText: string,
  deps: ExtractFieldModelDeps
): Promise<SourceVerification> {
  const base = { facilityId: facility.id, facilityName: facility.name, field, recordedValue, sourceUrl };

  if (!prefilter(pageText, field)) {
    console.log(`noMention: ${facility.id} ${field} — prefilter found no plausible mention (source: ${sourceUrl})`);
    return { ...base, outcome: "noMention", detail: "prefilter found no plausible mention of this field on the page" };
  }

  const extraction = await extractField(field, facility, pageText, deps);
  if (!extraction.ok) {
    console.log(
      `unreachable: ${facility.id} ${field} — model call unavailable (${extraction.modelFailureReason}) (source: ${sourceUrl})`
    );
    return { ...base, outcome: "unreachable", detail: `model call unavailable: ${extraction.modelFailureReason}` };
  }
  if (extraction.value === null) {
    console.log(
      `unconfirmed: ${facility.id} ${field} — model returned null (${extraction.reasonIfNull ?? "no reason given"}) (source: ${sourceUrl})`
    );
    return { ...base, outcome: "unconfirmed", detail: extraction.reasonIfNull ?? "model returned null" };
  }

  // The quote gate applies to the MODEL's OWN claimed value, before it is
  // ever compared to the record — see the file header. `extraction.value` is
  // guaranteed to match `isNumericField(field)`'s type by extractField's own
  // internal validation (the same field-tag-guarantees-shape pairing
  // extract-fields.ts relies on across its own module boundary), so the `as
  // number` cast below is safe.
  const grounded = isNumericField(field)
    ? quoteSupportsValue(extraction.verbatimQuote, extraction.value as number, pageText)
    : quoteVerbatim(extraction.verbatimQuote, pageText);
  if (!grounded) {
    console.log(
      `unconfirmed: ${facility.id} ${field} — model's quote failed the verbatim/value-grounding gate; NOT treated as a disagreement (source: ${sourceUrl})`
    );
    return {
      ...base,
      outcome: "unconfirmed",
      sourceStatedValue: extraction.value,
      verbatimQuote: extraction.verbatimQuote,
      detail:
        "model's quote is not a verbatim, value-supporting span of the page — treated as no reliable answer from this source, never as evidence of disagreement",
    };
  }

  const same = valuesReconcile(field, recordedValue, extraction.value);
  console.log(
    `${same ? "confirmed" : "disagreement"}: ${facility.id} ${field} recorded=${JSON.stringify(recordedValue)} source-states=${JSON.stringify(extraction.value)} (source: ${sourceUrl})`
  );
  return {
    ...base,
    outcome: same ? "confirmed" : "disagreement",
    sourceStatedValue: extraction.value,
    verbatimQuote: extraction.verbatimQuote,
  };
}

// ============================================================================
// Per-facility driver: reads EVERY cited source — PDF or HTML — for EVERY
// field under check — no early exit. See file header's "READ ALL SOURCES"
// section. PDF routing is shared with extract-fields.ts's `fetchSourceText`
// (see the file header's REUSE note) so this tool's PDF handling can never
// drift from that one's.
// ============================================================================

export interface VerifyFieldsDeps extends ExtractFieldModelDeps, SourceFetchDeps {
  now: () => Date;
  /**
   * Optional crash-durability hook — mirrors `RunExtractDeps.checkpoint` in
   * extract-fields.ts (see its doc-comment for the full design rationale).
   * Called once per facility processed (never per gap) with the summary
   * accumulated so far. Unlike extract-fields.ts, `VerifyFieldsSummary`'s
   * per-outcome counts ARE tallied incrementally inside the facility loop
   * (only `valuesChecked`/`valuesUnchecked`/`uncheckedValues` are filled in
   * afterward, in the reconciliation pass), so a checkpoint here can safely
   * persist the whole summary object, not just a sub-field. Wired by
   * `main()` ONLY when `--out` is set — a dry run must still write nothing.
   * A checkpoint failure must never abort the sweep.
   */
  checkpoint?: (summary: VerifyFieldsSummary) => void;
}

interface FacilityVerifyResult {
  results: SourceVerification[];
  /** At least one source fetched successfully AND cleared
   * MIN_READABLE_CHARS. Used only by the systemic-collapse abort guard. */
  sawAnyReadable: boolean;
  /** At least one source fetched successfully but was too thin to
   * read. Kept distinct from `sawAnyReadable` for the same reason
   * extract-fields.ts keeps its own `sawAnyUnreadable` distinct: a thin page
   * still proves the network path works, so it must reset the
   * consecutive-failure streak the same way a fully-readable page does —
   * only a genuine CONNECTION failure should ever increment it. */
  sawAnyThin: boolean;
}

async function verifyFacility(
  facility: Facility,
  fields: Array<{ field: ExtractableField; recordedValue: number | string }>,
  deps: VerifyFieldsDeps,
  fetchState: FetchState
): Promise<FacilityVerifyResult> {
  const results: SourceVerification[] = [];
  let sawAnyReadable = false;
  let sawAnyThin = false;

  for (const source of facility.sources) {
    const fetchResult = await fetchSourceText(source.url, deps, fetchState);

    if (!fetchResult.ok) {
      console.log(`unreachable: ${facility.id} — ${source.url} — fetch failed (${fetchResult.reason})`);
      for (const { field, recordedValue } of fields) {
        results.push({
          facilityId: facility.id,
          facilityName: facility.name,
          field,
          recordedValue,
          sourceUrl: source.url,
          outcome: "unreachable",
          detail: `fetch failed: ${fetchResult.reason}`,
        });
      }
      continue;
    }

    if (fetchResult.text.length < MIN_READABLE_CHARS) {
      sawAnyThin = true;
      console.log(
        `unreachable: ${facility.id} — ${source.url} — fetched but only ${fetchResult.text.length} chars (below MIN_READABLE_CHARS=${MIN_READABLE_CHARS}) — likely a JS-rendered or empty page`
      );
      for (const { field, recordedValue } of fields) {
        results.push({
          facilityId: facility.id,
          facilityName: facility.name,
          field,
          recordedValue,
          sourceUrl: source.url,
          outcome: "unreachable",
          detail: `fetched but below MIN_READABLE_CHARS (${fetchResult.text.length} chars) — this is NOT evidence the field is unstated`,
        });
      }
      continue;
    }

    sawAnyReadable = true;
    // Windowing depends only on facility identity + raw text, never on
    // `field` — computed ONCE per source and reused across every field under
    // check against it (mirrors extract-fields.ts's own per-source windowing).
    const windowed = windowText(fetchResult.text, facility.name, facility.location.city);

    for (const { field, recordedValue } of fields) {
      results.push(await classifyReadableSource(facility, field, recordedValue, source.url, windowed.text, deps));
    }
  }

  return { results, sawAnyReadable, sawAnyThin };
}

// ============================================================================
// Pipeline driver — runVerify: the testable core (no CLI/process concerns)
// ============================================================================

export interface RunVerifyOptions {
  fields: ExtractableField[];
  /** Caps the number of (facility, field) VALUES checked — i.e. slices the
   * `selectValuesToVerify()` list, the same gap-style semantics as
   * extract-fields.ts's own `--limit` (which slices `selectGaps()`, itself a
   * per-field, not per-facility, count). Does NOT cap the number of sources
   * read per value — every cited source for each of the (at most `limit`)
   * values is still read in full. */
  limit?: number;
  facilityId?: string;
  runId: string;
}

/**
 * Why a value contributed ZERO attempted (facility, field, source) triples —
 * see `VerifyFieldsSummary.uncheckedValues`'s doc-comment for why this is a
 * first-class finding, not an absence. `noSources` (a data-completeness gap
 * upstream of this tool: nothing was ever cited) and `abortedBeforeReached`
 * (says nothing about the facility's own sources — only that the run stopped
 * before reaching it, see `runVerify`'s abort design; re-running covers it,
 * no data fix implied) are the only two REACHABLE reasons, since F1: every
 * cited source — PDF or HTML — is now actually fetched, so a reached facility
 * with at least one source always contributes at least one triple (a failed
 * fetch or a too-thin read still yields an `unreachable` triple). `unclassified`
 * is kept ONLY as a structural safety net, mirroring extract-fields.ts's own
 * `unclassified` counter (see that field's doc-comment there): if this reason
 * is ever produced, that is a genuine accounting bug in this file, not a data
 * characteristic — a reached facility with sources somehow contributed zero
 * triples despite the invariant above. It should never appear in a correct
 * run.
 */
export type UncheckedReason = "noSources" | "abortedBeforeReached" | "unclassified";

export interface UncheckedValue {
  facilityId: string;
  facilityName: string;
  field: ExtractableField;
  recordedValue: number | string;
  reason: UncheckedReason;
}

export interface VerifyFieldsSummary {
  runId: string;
  generatedAt: string;
  facilitiesConsidered: number;
  /** Count of (facility, field) VALUES selected for checking — see
   * `RunVerifyOptions.limit`'s doc-comment. Always equals `valuesChecked +
   * valuesUnchecked` (see those fields' doc-comments) — this is a SEPARATE
   * identity from the triple-level one below, over a coarser unit. */
  valuesConsidered: number;
  /** Count of selected values with AT LEAST ONE attempted (facility, field,
   * source) triple — i.e. represented at least once in `results`, regardless
   * of that triple's outcome (even `unreachable` counts as "checked": the
   * tool DID attempt it, and that attempt is visible in `results`). */
  valuesChecked: number;
  /** Count of selected values with ZERO attempted triples — see
   * `UncheckedValue`'s doc-comment. THIS IS THE COVERAGE HOLE THE TRIPLE-
   * LEVEL ACCOUNTING CANNOT SEE: a value with zero triples produces no
   * `unreachable` result either (there was nothing to even fail to fetch —
   * there are no sources cited at all, or the run never reached the facility
   * because of an abort), so it is invisible to the five-outcome tally and
   * indistinguishable from "fully
   * covered" in `sourceChecksAttempted`/`results` alone. For a tool whose
   * entire purpose is correctness assurance, "this value could not be
   * checked" must be a first-class, separately-counted finding — never
   * silently folded into `valuesChecked` or dropped from the printed
   * summary (see `verify-fields.test.ts`'s mutation-test coverage for this
   * exact regression). */
  valuesUnchecked: number;
  /** Every unchecked value, with its reason — see `UncheckedReason`. Always
   * has length `valuesUnchecked`. Printed prominently, near the
   * disagreements, in `printHumanSummary` — a reader skimming the headline
   * must not be able to mistake partial coverage for full coverage. */
  uncheckedValues: UncheckedValue[];
  /** Total (facility, field, source) triples actually attempted — since F1
   * this includes PDF sources, which are fetched and read like any other
   * source. Always equals
   * `results.length` and always equals the sum of the five outcome counters
   * below, by construction (see file header's "ACCOUNTING" section). This is
   * the TRIPLE-level identity; `valuesConsidered = valuesChecked +
   * valuesUnchecked` above is the separate VALUE-level identity — both are
   * needed, deliberately kept as two distinct layers rather than merged into
   * one (see file header): the triple-level one proves every attempt landed
   * in exactly one outcome bucket, the value-level one proves every SELECTED
   * value was either attempted at all, or is explicitly flagged as not. */
  sourceChecksAttempted: number;
  confirmed: number;
  /** THE PAYLOAD — see file header. */
  disagreements: number;
  unconfirmed: number;
  noMention: number;
  unreachable: number;
  /** True iff CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD tripped and the run
   * stopped before reaching every selected value. Results found before the
   * abort are real and are never discarded. Every value belonging to a
   * facility the run never reached lands in `uncheckedValues` with reason
   * `abortedBeforeReached` — never silently absent. */
  aborted: boolean;
  abortReason: string | null;
  /** Every (facility, field, source) triple attempted, in the order
   * processed — the disagreements among these are the tool's entire reason
   * to exist; see `printHumanSummary`. */
  results: SourceVerification[];
}

type SummaryNumericKey = {
  [K in keyof VerifyFieldsSummary]: VerifyFieldsSummary[K] extends number ? K : never;
}[keyof VerifyFieldsSummary];

/**
 * Single-classification-map + one-tally-point accounting (see file header's
 * "ACCOUNTING" section). `Record<VerifyOutcome, ...>` is the load-bearing
 * part: TypeScript requires an entry for every member of the `VerifyOutcome`
 * union, so adding a new outcome without adding its mapping here fails
 * `npx tsc --noEmit` instead of silently vanishing from the reconciliation.
 */
const OUTCOME_TO_SUMMARY_KEY: Record<VerifyOutcome, SummaryNumericKey> = {
  confirmed: "confirmed",
  disagreement: "disagreements",
  unconfirmed: "unconfirmed",
  noMention: "noMention",
  unreachable: "unreachable",
};

/**
 * Runs the full verify-fields pipeline over `facilities`. Groups the
 * selected (facility, field) values by facility, then `verifyFacility` reads
 * through EVERY cited source (PDF or HTML, since F1) for that facility —
 * never just the first, and never stopping at the first confirmation (see
 * file header) — before every attempted (facility, field, source) triple is
 * pushed into `summary.results` and tallied via `OUTCOME_TO_SUMMARY_KEY`.
 * After the facility loop, a SEPARATE per-value reconciliation pass (see the
 * comment above it) classifies every originally-selected value as
 * `valuesChecked` (>=1 triple attempted) or `valuesUnchecked` (zero triples —
 * a facility with no sources at all, or one never reached because of an
 * abort) — the coverage hole the triple-level tally alone cannot see, since a
 * value with zero triples produces no `unreachable` result either. Ollama
 * itself is strictly serial, so this processes one facility (and within it,
 * one source, and within that, one field) at a time; never fans out with
 * Promise.all.
 *
 * A single `FetchState` (see extract-fields.ts) is created ONCE per
 * `runVerify` call — never module-scoped — and threaded through every
 * `verifyFacility`/`fetchSourceText` call in this run, so the shared
 * `pdf_extractor_unavailable` warning fires at most once per run here too.
 *
 * ABORT design: reuses `CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD` from
 * extract-fields.ts. A streak of CONSECUTIVE facilities that produced zero
 * readable sources (genuine connection failures only — a merely-thin/
 * JS-rendered page that DID fetch resets the streak, since it proves the
 * network path works; mirrors extract-fields.ts's own `sawAnyReadable`/
 * `sawAnyUnreadable` distinction) trips the guard: the facility loop
 * `break`s, `aborted`/`abortReason` are set, and every result found before
 * the abort is kept — never discarded. Since F1, a facility whose sources are
 * ALL PDFs is treated exactly like any other facility for this streak: its
 * PDFs are actually fetched, so a genuine PDF fetch failure increments the
 * streak the same as an HTML fetch failure would (removing the old exemption
 * — see the file header's ACCOUNTING section) — a run where every PDF fails
 * (e.g. `pdftotext`/poppler missing) SHOULD trip this guard, since that is
 * exactly the systemic-collapse signal it exists to catch.
 */
export async function runVerify(
  facilities: Facility[],
  opts: RunVerifyOptions,
  deps: VerifyFieldsDeps
): Promise<VerifyFieldsSummary> {
  const summary: VerifyFieldsSummary = {
    runId: opts.runId,
    generatedAt: deps.now().toISOString(),
    facilitiesConsidered: 0,
    valuesConsidered: 0,
    valuesChecked: 0,
    valuesUnchecked: 0,
    uncheckedValues: [],
    sourceChecksAttempted: 0,
    confirmed: 0,
    disagreements: 0,
    unconfirmed: 0,
    noMention: 0,
    unreachable: 0,
    aborted: false,
    abortReason: null,
    results: [],
  };

  const targetFacilities = opts.facilityId ? facilities.filter((f) => f.id === opts.facilityId) : facilities;

  let checks = selectValuesToVerify(targetFacilities, opts.fields);
  if (opts.limit !== undefined) {
    checks = checks.slice(0, opts.limit);
  }
  summary.valuesConsidered = checks.length;

  const byFacility = new Map<
    string,
    { facility: Facility; fields: Array<{ field: ExtractableField; recordedValue: number | string }> }
  >();
  for (const check of checks) {
    const entry = byFacility.get(check.facility.id);
    const item = { field: check.field, recordedValue: check.recordedValue };
    if (entry) {
      entry.fields.push(item);
    } else {
      byFacility.set(check.facility.id, { facility: check.facility, fields: [item] });
    }
  }
  summary.facilitiesConsidered = byFacility.size;

  // See CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD's doc-comment in
  // extract-fields.ts — counts consecutive facilities (not gaps) whose
  // sources ALL failed to fetch (not merely thin). Reset on any facility
  // that reads at least one source at all.
  let consecutiveTotalFetchFailures = 0;
  let abortReason: string | null = null;

  // Every facility actually handed to `verifyFacility` — i.e. NOT skipped by
  // an abort break. Drives the per-value `abortedBeforeReached` reason below;
  // deliberately tracked as "was it attempted at all" rather than derived
  // from `aborted`, since it stays correct (empty-set-relevant) even on a
  // non-aborted run.
  const reachedFacilityIds = new Set<string>();

  // One instance per `runVerify` call — see `FetchState`'s doc-comment in
  // extract-fields.ts — so the pdf_extractor_unavailable warning's "once per
  // run" guarantee can never leak across independent runs or tests.
  const fetchState: FetchState = createFetchState();

  for (const { facility, fields } of byFacility.values()) {
    reachedFacilityIds.add(facility.id);
    const result = await verifyFacility(facility, fields, deps, fetchState);
    for (const item of result.results) {
      summary.results.push(item);
      summary.sourceChecksAttempted++;
      summary[OUTCOME_TO_SUMMARY_KEY[item.outcome]]++;
    }

    if (result.sawAnyReadable || result.sawAnyThin) {
      consecutiveTotalFetchFailures = 0;
    } else if (result.results.length > 0) {
      // Every attempted source for this facility was a genuine connection
      // failure (never merely thin — since F1 this includes PDF sources too,
      // see this function's doc-comment for why the old all-PDF exemption
      // was removed).
      consecutiveTotalFetchFailures++;
      if (consecutiveTotalFetchFailures >= CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD) {
        abortReason =
          `ABORTING: ${consecutiveTotalFetchFailures} consecutive facilities produced ZERO readable sources ` +
          `(most recent: ${facility.id}). This pattern is symptomatic of a SYSTEMIC fetch failure, not scattered ` +
          `link rot — a verification run that cannot fetch has verified nothing and must not exit 0 reporting ` +
          `"all confirmed." Check the network_error errorCode/errorMessage fields fetchPageText surfaces ` +
          `(scripts/discovery/fetch-page-text.ts) to diagnose the underlying cause before re-running. Do not raise ` +
          `this threshold to make the symptom go away.`;
        console.error(abortReason);
        break;
      }
    }

    // Checkpoint once per facility processed — see
    // `VerifyFieldsDeps.checkpoint`'s doc-comment.
    deps.checkpoint?.(summary);
  }

  if (abortReason !== null) {
    summary.aborted = true;
    summary.abortReason = abortReason;
  }

  // === Per-VALUE reconciliation (the second, coarser accounting layer —
  // see VerifyFieldsSummary's doc-comments and the file header's
  // "ACCOUNTING" section for why this is separate from the triple-level
  // one). `checkedKeys` is built independently from `summary.results`
  // (already fully populated above); every ORIGINALLY SELECTED `check` is
  // then classified by asking "does at least one attempted triple exist for
  // this exact (facility, field) pair?" — never by subtracting from
  // `valuesConsidered`, which would just be arithmetic asserting nothing.
  // This mirrors the triple-level identity's own "holds structurally, not
  // merely believed" property: every `check` is visited exactly once below
  // and lands in exactly one of `valuesChecked`/`uncheckedValues`, so
  // `valuesChecked + valuesUnchecked === valuesConsidered` by construction.
  const checkedKeys = new Set<string>();
  for (const item of summary.results) {
    checkedKeys.add(`${item.facilityId}::${item.field}`);
  }
  for (const check of checks) {
    const key = `${check.facility.id}::${check.field}`;
    if (checkedKeys.has(key)) {
      summary.valuesChecked++;
      continue;
    }
    let reason: UncheckedReason;
    if (!reachedFacilityIds.has(check.facility.id)) {
      reason = "abortedBeforeReached";
    } else if (check.facility.sources.length === 0) {
      reason = "noSources";
    } else {
      // Structurally unreachable since F1: a REACHED facility with at least
      // one cited source always contributes at least one triple now that
      // every source — PDF or HTML — is actually fetched (a failed fetch or
      // too-thin read still yields an `unreachable` triple). Reaching this
      // branch means that invariant broke — a genuine accounting bug in this
      // file, not a data characteristic (mirrors extract-fields.ts's own
      // `unclassified` sentinel) — so it is logged loudly rather than
      // silently swallowed.
      reason = "unclassified";
      console.error(
        `unclassified: ${check.facility.id} ${check.field} — reached facility with sources but zero attempted ` +
          `triples; this should be impossible since F1 and indicates an accounting bug in verify-fields.ts`
      );
    }
    summary.uncheckedValues.push({
      facilityId: check.facility.id,
      facilityName: check.facility.name,
      field: check.field,
      recordedValue: check.recordedValue,
      reason,
    });
    summary.valuesUnchecked++;
  }

  return summary;
}

// ============================================================================
// CLI
// ============================================================================

interface CliArgs {
  outPath?: string;
  limit?: number;
  fields: ExtractableField[];
  facilityId?: string;
  runId: string;
}

/**
 * Fallback used when `--limit` is PRESENT on the command line but not
 * parseable as a positive integer (`--limit=abc`, `--limit=0`,
 * `--limit=-5`, an empty value). Kept as a named constant, not a bare
 * literal, so the "why 500" reasoning stays attached to the value.
 */
const INVALID_LIMIT_FALLBACK = 500;

/**
 * Parses a `--limit` value that was actually supplied. `limit === undefined`
 * means "no bound" downstream — see `if (opts.limit !== undefined) { checks
 * = checks.slice(0, opts.limit); }` — and that is the correct, deliberate
 * meaning of OMITTING `--limit` entirely (an operator asking for a full
 * sweep). `raw === undefined` here reflects exactly that omission, so it is
 * the only input allowed to return `undefined`.
 *
 * A PRESENT-but-invalid value must never collapse to that same `undefined`:
 * doing so is the bug this function exists to close — `--limit=abc` used to
 * silently produce an unbounded, ~12-hour sweep over the full check set.
 * Clamp it to `INVALID_LIMIT_FALLBACK` instead, and say so loudly on stderr.
 */
function parseLimitArg(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.floor(parsed);
  }
  console.warn(
    `--limit: invalid value ${JSON.stringify(raw)} (expected a positive integer) — falling back to ${INVALID_LIMIT_FALLBACK}.`
  );
  return INVALID_LIMIT_FALLBACK;
}

export function parseArgs(argv: string[]): CliArgs {
  let outPath: string | undefined;
  let limit: number | undefined;
  let fields: ExtractableField[] = [...EXTRACTABLE_FIELDS];
  let facilityId: string | undefined;
  let runId = `track5-verify-${Date.now()}`;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--out") {
      outPath = argv[++i];
    } else if (flag.startsWith("--out=")) {
      outPath = flag.slice("--out=".length);
    } else if (flag === "--limit") {
      // A bare trailing `--limit`, or `--limit` immediately followed by
      // another flag (`--limit --fields=x`), supplies no value. Do NOT
      // consume the next token as the value in that case — that would both
      // swallow a real flag and (via parseLimitArg's own `raw === undefined`
      // contract) silently produce the unbounded sweep this whole function
      // exists to prevent. Treat "no value supplied" the same as the already
      // -handled `--limit=` empty-string case instead, and don't advance `i`
      // past a token we didn't consume.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        limit = parseLimitArg(next);
        i++;
      } else {
        limit = parseLimitArg("");
      }
    } else if (flag.startsWith("--limit=")) {
      limit = parseLimitArg(flag.slice("--limit=".length));
    } else if (flag === "--fields") {
      fields = parseFieldsArg(argv[++i]);
    } else if (flag.startsWith("--fields=")) {
      fields = parseFieldsArg(flag.slice("--fields=".length));
    } else if (flag === "--facility") {
      facilityId = argv[++i];
    } else if (flag.startsWith("--facility=")) {
      facilityId = flag.slice("--facility=".length);
    } else if (flag.startsWith("--run-id=")) {
      runId = flag.slice("--run-id=".length);
    }
  }

  return { outPath, limit, fields, facilityId, runId };
}

/** Loads the live facility set — read API first, JSON file fallback. Same
 * pattern as extract-fields.ts's own (unexported) loader — duplicated rather
 * than imported since extract-fields.ts does not export it. */
async function loadFacilities(baseUrl: string): Promise<Facility[]> {
  try {
    const res = await fetch(`${baseUrl}/api/facilities`);
    if (res.ok) {
      const body = (await res.json()) as { facilities: Facility[] };
      return body.facilities;
    }
  } catch {
    // fall through to file fallback
  }

  const jsonPath = path.join(process.cwd(), "data", "facilities.json");
  const raw = readFileSync(jsonPath, "utf-8");
  return JSON.parse(raw) as Facility[];
}

/**
 * Always printed, regardless of --out. Disagreements are listed FIRST — each
 * with facility id, field, recorded value, source-stated value, the
 * verbatim quote, and the source URL, so a human can adjudicate one in
 * seconds without opening this run's JSON output at all.
 */
function printHumanSummary(summary: VerifyFieldsSummary): void {
  const disagreements = summary.results.filter((r) => r.outcome === "disagreement");

  console.log(`\n=== DISAGREEMENTS (${disagreements.length}) — the only actionable signal from this tool ===`);
  if (disagreements.length === 0) {
    console.log("(none)");
  } else {
    for (const d of disagreements) {
      console.log(`\n- ${d.facilityId} — ${d.field}`);
      console.log(`  recorded:      ${JSON.stringify(d.recordedValue)}`);
      console.log(`  source states: ${JSON.stringify(d.sourceStatedValue)}`);
      console.log(`  quote:         "${d.verbatimQuote}"`);
      console.log(`  source:        ${d.sourceUrl}`);
    }
  }

  // Printed prominently, right after the disagreements and BEFORE the raw
  // JSON dump, so a reader skimming for the headline cannot mistake partial
  // coverage for full coverage — see the file header's "ACCOUNTING" section
  // on why a value with zero attempted triples is otherwise invisible.
  console.log(`\n=== COVERAGE ===`);
  if (summary.valuesUnchecked > 0) {
    console.log(
      `⚠️  ${summary.valuesUnchecked} of ${summary.valuesConsidered} selected values could NOT be checked ` +
        `at all (zero sources attempted) — these are NOT confirmed, NOT disagreements, and NOT even "no mention": ` +
        `they were never read.`
    );
    for (const u of summary.uncheckedValues) {
      console.log(`  - ${u.facilityId} — ${u.field} (recorded ${JSON.stringify(u.recordedValue)}) — reason: ${u.reason}`);
    }
  } else {
    console.log(`All ${summary.valuesConsidered} selected values had at least one source attempted.`);
  }

  console.log(`\n=== SUMMARY ===`);
  const { results, uncheckedValues, ...rest } = summary;
  console.log(JSON.stringify({ ...rest, resultCount: results.length, uncheckedValueCount: uncheckedValues.length }, null, 2));

  if (summary.aborted) {
    console.error(`\n${summary.abortReason}`);
  }
}

/**
 * Constructs the real fetch/Ollama implementations. Called ONLY from inside
 * `main()`, never at module scope — mirrors extract-fields.ts's
 * `buildRealDeps`: importing this module for tests must never open a socket.
 */
function buildRealDeps(): VerifyFieldsDeps {
  return {
    fetchPageTextImpl: (url) => fetchPageText(url, { fetchImpl: fetch }),
    fetchPdfTextImpl: (url) => fetchPdfText(url, { fetchImpl: fetch }),
    callOllamaImpl: (opts) => callOllama<ModelExtraction>({ ...opts, fetchImpl: fetch }),
    now: () => new Date(),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
  const facilities = await loadFacilities(baseUrl);

  const deps = buildRealDeps();
  if (args.outPath) {
    const outPath = args.outPath;
    mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    // Checkpoint once per facility processed so a crash mid-sweep (OOM, the
    // machine sleeping, Ollama dying, ^C) loses at most one facility's worth
    // of work instead of the entire ~17h run — see `VerifyFieldsDeps.checkpoint`.
    // Wired ONLY when --out is set: a dry run must still write nothing.
    deps.checkpoint = (partial) => {
      try {
        atomicWriteJson(outPath, partial);
      } catch (err) {
        // Losing a checkpoint is survivable; killing a 17-hour sweep over a
        // transient write failure is not.
        console.error(`checkpoint write failed (continuing sweep): ${err instanceof Error ? err.message : String(err)}`);
      }
    };
  }

  const summary = await runVerify(
    facilities,
    { fields: args.fields, limit: args.limit, facilityId: args.facilityId, runId: args.runId },
    deps
  );

  printHumanSummary(summary);

  if (args.outPath) {
    mkdirSync(path.dirname(path.resolve(args.outPath)), { recursive: true });
    writeFileSync(args.outPath, JSON.stringify(summary, null, 2));
    console.log(`\nwrote full report to ${args.outPath}`);
  } else {
    console.log("\n(no --out given — report not written to disk)");
  }

  if (summary.aborted) {
    // process.exitCode (not process.exit()) so the writes/console output
    // above are guaranteed to flush before the process actually exits.
    process.exitCode = 1;
  }
}

// Only run the CLI when this file is executed directly, not when its
// functions are imported by the test suite — matches extract-fields.ts's
// isMain guard.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
