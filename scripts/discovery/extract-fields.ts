/**
 * Track 5: fills missing fields on LIVE facilities by re-reading the sources
 * those facilities already cite, using a local Ollama model. This is an
 * enrichment tool, not a discovery tool — it never proposes new facilities
 * and it never overwrites a curated value (see lib/enrichment-update.ts's
 * fill-missing invariant, which the output of this script is built to
 * satisfy).
 *
 * NEVER writes live data. This script's only side effect is writing a
 * candidates JSON file (via --out); the operator pipes that file through the
 * existing `submit-candidates.ts <path>`, which stages everything as
 * `pending` for human review. Dry run (no --out) is the DEFAULT: it prints a
 * summary and writes nothing.
 *
 * Fields covered (one field per model call, deliberately never batched — see
 * `extractField`'s doc-comment for the measured reason): `capacityMw.planned`,
 * `capacityMw.operational`, `energy.onSiteGenerationMw`, `energy.source`,
 * `energy.utility`. `energy.notes` is intentionally NOT covered — generating
 * prose from a small local model is a fabrication surface this script does
 * not open.
 *
 * Pipeline (each stage below is a pure, independently-testable function):
 *   1. selectGaps      — which (facility, field) pairs are currently missing.
 *   2. prefilter        — cheap regex gate; skip a model call the page almost
 *                          certainly can't answer. A COST filter, not a
 *                          correctness filter (measured ~1.4x reduction).
 *   3. windowText        — for long documents (>20,000 chars), extract
 *                          ±3,000-char windows anchored on the facility's
 *                          DISTINCTIVE name tokens (rarest-first), never a
 *                          head truncation — see that function's doc-comment.
 *   4. extractField      — one grammar-constrained callOllama per (page, field).
 *   5. quoteVerbatim / quoteSupportsValue — mechanical quote gate; can only
 *                          ever downgrade a model "yes", never uphold one on
 *                          trust.
 *   5.5 isDuplicateOfRecordedSibling — drops an extracted `capacityMw.planned`/
 *                          `capacityMw.operational` that merely repeats the
 *                          OTHER capacityMw sub-field already recorded on the
 *                          facility (same fact re-read, not a new one).
 *   6. toEnrichmentIntents — emits the `{ enrichmentUpdate, provenance }`
 *                          shape submit-candidates.ts already accepts.
 *
 * `processFacilitySources` drives stages 2-5.5 across a facility's cited
 * sources IN ORDER — not just the first readable one — reading as many as it
 * takes to fill every requested field, stopping early the instant they're all
 * filled. Different fields can legitimately end up sourced from different
 * pages; `toEnrichmentIntents` records exactly which source backed which
 * value.
 *
 * ⚠️ KNOWN LIMIT (documented, not fixed here): the quote gate proves a
 * number+unit genuinely appears on the page, verbatim, near the facility's
 * name — it CANNOT prove that figure was reported for the field the model
 * assigned it to (e.g. a genuine "36 MW" describing on-site backup generation
 * could be misfiled as `capacityMw.operational`). Mechanical grounding bounds
 * fabrication, never semantics. That gap is exactly what human review (the
 * `pending` queue) is for — a clean pass through this script's gates is not a
 * substitute for it.
 *
 * All side-effecting dependencies (fetch, the Ollama call, the clock) are
 * injected — see `RunExtractDeps` — following the `RunSubmitDeps` pattern in
 * submit-candidates.ts, so the whole pipeline is testable with no network and
 * no model. `main()` builds the real implementations lazily, and ONLY inside
 * itself, for the same reason documented at submit-candidates.ts's
 * `buildRealVerifyImpl`: importing/loading this module for tests must never
 * open a socket.
 *
 * Run via:
 *   npx tsx --env-file=.env.local scripts/discovery/extract-fields.ts \
 *     --out <path> [--limit N] [--fields capacityMw.planned,energy.source] \
 *     [--facility <id>] [--run-id ID]
 *   (omit --out for a dry run: prints a summary, writes nothing)
 *
 * Never imports or touches the DB, never calls createSubmission — this
 * script's only write is the candidates file itself.
 *
 * Uses relative imports throughout — tsx does not resolve the `@/*` path
 * alias, matching the rest of scripts/discovery/.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Facility, Source } from "../../lib/schema";
import { enrichmentUpdateIntentSchema } from "../../lib/enrichment-update";
import { callOllama, type CallOllamaOptions, type CallOllamaResult } from "./ollama-client";
import { fetchPageText, type FetchPageTextResult } from "./fetch-page-text";

// ============================================================================
// Fields covered
// ============================================================================

export const EXTRACTABLE_FIELDS = [
  "capacityMw.planned",
  "capacityMw.operational",
  "energy.onSiteGenerationMw",
  "energy.source",
  "energy.utility",
] as const;

export type ExtractableField = (typeof EXTRACTABLE_FIELDS)[number];

const NUMERIC_FIELDS = new Set<ExtractableField>([
  "capacityMw.planned",
  "capacityMw.operational",
  "energy.onSiteGenerationMw",
]);

function isNumericField(field: ExtractableField): boolean {
  return NUMERIC_FIELDS.has(field);
}

// Mirrors lib/schema.ts's energySchema.source enum exactly — kept as a local
// literal (rather than unwrapped from the zod schema) for a plain JSON-schema
// `enum` array. If lib/schema.ts's enum ever changes, update this too.
const ENERGY_SOURCE_VALUES = [
  "grid",
  "on_site_gas",
  "nuclear",
  "solar",
  "wind",
  "hydro",
  "mixed",
  "other",
] as const;
type EnergySourceValue = (typeof ENERGY_SOURCE_VALUES)[number];

// ============================================================================
// Stage 1 — selectGaps: which (facility, field) pairs are currently missing
// ============================================================================

export interface FieldGap {
  facility: Facility;
  field: ExtractableField;
}

function fieldIsMissing(facility: Facility, field: ExtractableField): boolean {
  switch (field) {
    case "capacityMw.planned":
      return facility.capacityMw?.planned === undefined;
    case "capacityMw.operational":
      return facility.capacityMw?.operational === undefined;
    case "energy.onSiteGenerationMw":
      return facility.energy?.onSiteGenerationMw === undefined;
    case "energy.source":
      return facility.energy?.source === undefined;
    case "energy.utility":
      return facility.energy?.utility === undefined;
  }
}

/** Every (facility, field) pair in `facilities` × `fields` whose target field
 * is currently undefined. Order: outer loop over facilities, inner loop over
 * `fields` in the order given. */
export function selectGaps(facilities: Facility[], fields: ExtractableField[]): FieldGap[] {
  const gaps: FieldGap[] = [];
  for (const facility of facilities) {
    for (const field of fields) {
      if (fieldIsMissing(facility, field)) {
        gaps.push({ facility, field });
      }
    }
  }
  return gaps;
}

// ============================================================================
// Stage 2 — prefilter: cheap regex gate, a COST saver not a correctness gate
// ============================================================================

// Deliberately includes kW/kilowatt alongside MW/megawatt/GW/gigawatt — a
// real page stated "Capacity 1,000 kW" and an MW-only regex would have
// skipped it entirely, never even reaching the model.
const POWER_UNIT_RE = /\d[\d,.]*\s*-?\s*(kw|kilowatts?|mw|megawatts?|gw|gigawatts?)\b/i;
const ENERGY_SOURCE_HINT_RE =
  /\b(grid power|on-?site gas|natural gas|nuclear|solar|wind|hydro(?:electric)?|renewable|behind-the-meter|fuel cell|diesel generator|power source|energy source|electricity (?:comes|is drawn) from)\b/i;
const ENERGY_UTILITY_HINT_RE =
  /\b(utility|utilities|electric (?:co(?:mpany|operative)?|cooperative)|power company|served by|serves the|energy provider|transmission (?:provider|operator)|distribution utility)\b/i;

/**
 * True if `text` could plausibly contain an answer for `field` — a cheap
 * regex gate that skips a model call the page almost certainly can't answer.
 * Measured reduction is only ~1.4x, so this exists to save cost, not to
 * screen for correctness (a page that passes still goes through the full
 * model + quote-gate pipeline below).
 */
export function prefilter(text: string, field: ExtractableField): boolean {
  if (isNumericField(field)) return POWER_UNIT_RE.test(text);
  if (field === "energy.source") return ENERGY_SOURCE_HINT_RE.test(text);
  return ENERGY_UTILITY_HINT_RE.test(text); // energy.utility
}

// ============================================================================
// Stage 3 — windowText: entity-anchored windowing for long documents
// ============================================================================

// Ported from plans/ollama-bench/fetch-pages.mjs (s97) — see that file's
// header comment for the measured failure this exists to prevent: a 20k-char
// HEAD slice of an 809k-char SEC filing contained zero MW figures and not
// even the facility's name. Windows are anchored on the ENTITY, never the
// unit token — anchoring on "MW" would hand the model pre-filtered evidence.
const GENERIC_TOKENS = new Set([
  "data", "center", "centers", "centre", "datacenter", "campus", "the", "of", "and",
  "llc", "inc", "corp", "corporation", "company", "technology", "park", "power", "station",
  "project", "site", "facility", "facilities", "phase", "north", "south", "east", "west",
  "county", "city", "town", "township", "development", "group", "holdings", "energy",
  "digital", "mining", "american", "national", "proposed",
]);

const HEAD_LIMIT = 20_000; // short docs pass through untouched
const WINDOW_RADIUS = 3_000; // chars kept either side of an entity mention
const MAX_WINDOWS = 12;
const TOTAL_WINDOW_CHAR_CAP = 45_000; // ~11k tokens, well inside num_ctx 16384

/** Lowercase, alphanumeric-only tokens from `name`/`city` with generic
 * descriptor words dropped — the tokens distinctive enough to anchor a
 * window on THIS facility rather than facilities in general. */
export function distinctiveTokens(name: string, city?: string): string[] {
  const tokens = `${name} ${city ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !GENERIC_TOKENS.has(token) && !/^\d+$/.test(token));
  return [...new Set(tokens)];
}

export interface WindowResult {
  text: string;
  mode: "full" | "windowed" | "head-fallback";
  windows: number;
}

/**
 * Docs <= HEAD_LIMIT pass through unchanged. Longer docs are windowed around
 * mentions of `name`/`city`'s distinctive tokens, RAREST token first (see the
 * comment inline below for why — anchoring on a common token, e.g. the
 * operator name, merges every window into one giant span). Windows are
 * merged when they overlap, clamped to TOTAL_WINDOW_CHAR_CAP, and NEVER
 * returned empty: a doc with no distinctive-token hits at all, or whose
 * merged windows collapse to a near-empty string, falls back to a head slice
 * rather than emitting nothing.
 */
export function windowText(text: string, name: string, city?: string): WindowResult {
  if (text.length <= HEAD_LIMIT) {
    return { text, mode: "full", windows: 0 };
  }

  const tokens = distinctiveTokens(name, city);
  const byToken: Array<{ token: string; indices: number[] }> = [];
  for (const token of tokens) {
    const re = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const indices: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null && indices.length < 500) {
      indices.push(match.index);
    }
    if (indices.length > 0) byToken.push({ token, indices });
  }

  if (byToken.length === 0) {
    return { text: text.slice(0, HEAD_LIMIT), mode: "head-fallback", windows: 0 };
  }

  // Rank by rarity, not by token order: anchoring on a common token (e.g. the
  // operator's own name appearing throughout a filing) merges every window
  // into one giant span whose budget-clamped prefix is pure boilerplate —
  // head truncation wearing a windowing costume. See fetch-pages.mjs (s97).
  byToken.sort((a, b) => a.indices.length - b.indices.length);

  const hits: number[] = [];
  for (const { indices } of byToken) {
    if (hits.length >= MAX_WINDOWS * 2) break;
    hits.push(...indices.slice(0, MAX_WINDOWS * 2 - hits.length));
  }
  hits.sort((a, b) => a - b);

  const spans: Array<[number, number]> = [];
  for (const hit of hits) {
    const start = Math.max(0, hit - WINDOW_RADIUS);
    const end = Math.min(text.length, hit + WINDOW_RADIUS);
    const last = spans[spans.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      spans.push([start, end]);
    }
    if (spans.length > MAX_WINDOWS * 3) break;
  }

  const kept: string[] = [];
  let total = 0;
  for (const [start, end] of spans.slice(0, MAX_WINDOWS)) {
    const remaining = TOTAL_WINDOW_CHAR_CAP - total;
    if (remaining <= 0) break;
    // A merged span can exceed the whole remaining budget on a doc that
    // mentions the entity throughout — clamp to what's left instead of
    // dropping the span outright, which would silently shrink the kept set
    // (and, in the worst case, produce an empty result).
    const chunk = text.slice(start, end).slice(0, remaining);
    kept.push(chunk);
    total += chunk.length;
  }

  const joined = kept.join("\n […] \n");
  if (joined.length < 400) {
    return { text: text.slice(0, HEAD_LIMIT), mode: "head-fallback", windows: 0 };
  }
  return { text: joined, mode: "windowed", windows: kept.length };
}

// ============================================================================
// Stage 4 — extractField: one grammar-constrained callOllama per (page, field)
// ============================================================================

/**
 * This EXACT text is load-bearing — measured as a THREE-WAY CONJUNCTION
 * (entity-binding instruction + unit-conversion instruction + verbatim-quote
 * instruction); dropping any one part silently turns correct extractions
 * into null. Do not "improve" it without re-measuring.
 */
const SYSTEM_PROMPT =
  "You extract ONE field about ONE named facility from a web page. Return the value ONLY if the page explicitly states it FOR THAT SPECIFIC FACILITY. If the page does not state it, or states it for a different site/company-wide total, return null. Never estimate, never infer, never use outside knowledge. UNITS: capacity fields are in MEGAWATTS (MW). If the page states capacity in gigawatts (GW), convert it and return megawatts: 1 GW = 1000 MW (e.g. '1GW' -> 1000, '2.5 GW' -> 2500). Kilowatts: 1000 kW = 1 MW. Converting a stated unit is not inference; report the converted number. verbatimQuote must be text copied exactly from the page (quote the ORIGINAL units as written); null if value is null. If you return null, set reasonIfNull to a one-sentence explanation.";

const FIELD_DESCRIPTIONS: Record<ExtractableField, string> = {
  "capacityMw.planned":
    "the facility's PLANNED total capacity, in megawatts (MW) — the capacity once fully built out, whether or not it is online yet.",
  "capacityMw.operational":
    "the facility's CURRENTLY OPERATIONAL (already online) capacity, in megawatts (MW).",
  "energy.onSiteGenerationMw":
    "the facility's on-site power generation capacity, in megawatts (MW) — power the facility itself generates on-site, not grid power it draws.",
  "energy.source": `the facility's primary energy source. Classify it as EXACTLY ONE of: ${ENERGY_SOURCE_VALUES.join(", ")}. Return this classification string, or null if the page does not state it.`,
  "energy.utility": "the name of the utility company that serves (provides grid power to) the facility.",
};

/**
 * Facility name/operator/city/state are always included. lib/schema.ts's
 * Facility type does not currently carry an aliases/alternate-name field, so
 * there is nothing further to add here yet — but omitting alternate names
 * entirely is a measured miss (a page called a facility "the Ellendale
 * campus" while the record's canonical name was "Polaris Forge 1", and the
 * model correctly refused to bind them). If an aliases field is ever added to
 * the schema, extend this function to include it.
 */
export function buildUserPrompt(field: ExtractableField, facility: Facility, pageText: string): string {
  return `Facility: "${facility.name}" (operator: ${facility.operator}; city: ${facility.location.city ?? "unknown"}; state: ${facility.location.state}).

Field to extract: ${FIELD_DESCRIPTIONS[field]}

=== BEGIN UNTRUSTED PAGE TEXT ===
${pageText}
=== END UNTRUSTED PAGE TEXT ===`;
}

function fieldValueSchema(field: ExtractableField): object {
  if (field === "energy.source") {
    // A CLASSIFICATION, not free text — constrain the schema to the enum
    // (plus null), not the generic string|number|null shape used elsewhere.
    return { type: ["string", "null"], enum: [...ENERGY_SOURCE_VALUES, null] };
  }
  if (field === "energy.utility") {
    return { type: ["string", "null"] };
  }
  return { type: ["number", "null"] }; // capacityMw.planned | capacityMw.operational | energy.onSiteGenerationMw
}

export function fieldJsonSchema(field: ExtractableField): object {
  return {
    type: "object",
    properties: {
      value: fieldValueSchema(field),
      verbatimQuote: { type: ["string", "null"] },
      // Load-bearing, not decoration — measured 0/6 -> 6/6 correct nulls once
      // this field was required, forcing the model to justify a null instead
      // of defaulting to it.
      reasonIfNull: { type: ["string", "null"] },
    },
    required: ["value", "verbatimQuote", "reasonIfNull"],
    additionalProperties: false,
  };
}

export interface ModelExtraction {
  value: number | string | null;
  verbatimQuote: string | null;
  reasonIfNull: string | null;
}

function isModelExtraction(data: unknown): data is ModelExtraction {
  if (typeof data !== "object" || data === null) return false;
  const candidate = data as Record<string, unknown>;
  const valueOk =
    candidate.value === null || typeof candidate.value === "number" || typeof candidate.value === "string";
  const quoteOk = candidate.verbatimQuote === null || typeof candidate.verbatimQuote === "string";
  const reasonOk = candidate.reasonIfNull === null || typeof candidate.reasonIfNull === "string";
  return valueOk && quoteOk && reasonOk;
}

/** Runtime floor under a field's specific value constraint — `callOllama`
 * only confirms the parsed JSON is an object; the JSON-schema `enum`/`type`
 * sent to the model constrains it via grammar-decoding, but that is an
 * assumption, not a guarantee (see ollama-client.ts's `:cloud`-model trap and
 * verify-source.ts's `isModelVerdict` for the same class of defense). */
function isValidValueForField(field: ExtractableField, value: number | string | null): boolean {
  if (value === null) return true;
  if (field === "energy.source") {
    return typeof value === "string" && (ENERGY_SOURCE_VALUES as readonly string[]).includes(value);
  }
  if (field === "energy.utility") {
    return typeof value === "string";
  }
  return typeof value === "number" && Number.isFinite(value);
}

export interface ExtractionOutcome {
  field: ExtractableField;
  /** False when the model call itself failed, or its response didn't match
   * the expected shape/constraint — "we could not get a usable extraction,"
   * never a judgment about the facility. */
  ok: boolean;
  value: number | string | null;
  verbatimQuote: string | null;
  reasonIfNull: string | null;
  modelFailureReason?: string;
}

export interface ExtractFieldModelDeps {
  callOllamaImpl: (opts: Omit<CallOllamaOptions, "fetchImpl">) => Promise<CallOllamaResult<ModelExtraction>>;
}

/**
 * Calls the model for exactly ONE field against ONE page. Never batches
 * multiple fields into one call — measured directly: a 7-fields-in-one-call
 * prompt returned 2/7 and silently dropped a $1B figure present in plain
 * text on the page, while one-at-a-time returned 4/4 and was faster per
 * field.
 */
export async function extractField(
  field: ExtractableField,
  facility: Facility,
  pageText: string,
  deps: ExtractFieldModelDeps
): Promise<ExtractionOutcome> {
  const result = await deps.callOllamaImpl({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildUserPrompt(field, facility, pageText),
    jsonSchema: fieldJsonSchema(field),
    numCtx: 16384,
  });

  if (!result.ok) {
    return { field, ok: false, value: null, verbatimQuote: null, reasonIfNull: null, modelFailureReason: result.reason };
  }
  if (!isModelExtraction(result.data)) {
    return {
      field,
      ok: false,
      value: null,
      verbatimQuote: null,
      reasonIfNull: null,
      modelFailureReason: "model response did not match the expected extraction shape",
    };
  }
  if (!isValidValueForField(field, result.data.value)) {
    return {
      field,
      ok: false,
      value: null,
      verbatimQuote: null,
      reasonIfNull: null,
      modelFailureReason: `model returned a value that does not match the ${field} constraint: ${JSON.stringify(result.data.value)}`,
    };
  }

  return {
    field,
    ok: true,
    value: result.data.value,
    verbatimQuote: result.data.verbatimQuote,
    reasonIfNull: result.data.reasonIfNull,
  };
}

// ============================================================================
// Stage 5 — quote gate: mechanical, can only ever DOWNGRADE a model "yes"
// ============================================================================

// Ported from plans/ollama-bench/quote.mjs (s97). See that file's header for
// why this is not a plain substring test: three stricter rules were tried and
// each false-rejected genuinely correct answers (line-wrapped quotes,
// sentence-stitched quotes, and short-but-real quotes like "Capacity 1,000
// kW" or "~48 MW"). NORMALIZATION IS THE WHOLE BALLGAME (measured s97): under
// whitespace-only normalization this killed 10 of 26 CORRECT extractions —
// not fabrications, just literal `\"` quote marks and undecoded HTML entities
// around a genuine span. Collapsing both sides to alphanumerics+spaces fixed
// that without loosening what counts as fabricated.
function normAlnum(input: string | null): string {
  return String(input ?? "")
    .toLowerCase()
    .replace(/&#\d+;|&[a-z]+;/g, " ") // undecoded HTML entities
    .replace(/[^a-z0-9]+/g, " ") // punctuation, quote marks, dashes, NBSP
    .trim();
}

/** Whitespace-only normalization, for pulling number+unit pairs out of a
 * quote — the alphanumeric collapse in `normAlnum` would split "1,000 kW"
 * into "1 000 kw" and destroy the number the reconciliation below depends on. */
function softNorm(input: string | null): string {
  return String(input ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

const UNIT_TO_MW: Record<string, number> = {
  kw: 0.001,
  kilowatt: 0.001,
  kilowatts: 0.001,
  mw: 1,
  megawatt: 1,
  megawatts: 1,
  gw: 1000,
  gigawatt: 1000,
  gigawatts: 1000,
};
const NUM_UNIT_RE = /(\d[\d,.]*)\s*-?\s*(kw|kilowatts?|mw|megawatts?|gw|gigawatts?)\b/gi;

/** Every number in `quote` that carries a power unit, converted to MW. */
export function quotedMwValues(quote: string | null): number[] {
  const out: number[] = [];
  for (const match of softNorm(quote).matchAll(NUM_UNIT_RE)) {
    const n = Number(match[1].replace(/,/g, ""));
    const mult = UNIT_TO_MW[match[2].toLowerCase()];
    if (Number.isFinite(n) && mult) out.push(n * mult);
  }
  return out;
}

/**
 * Is `quote` a real span of `pageText`? Allows line-wrapping (via whitespace
 * normalization) and sentence-stitching (a quote made of 1..N non-adjacent
 * sentence fragments, each independently verified — gpt-oss:20b was measured
 * returning a correct verdict whose quote combined two real, non-adjacent
 * sentences; a strict single-substring rule would reject that correct
 * answer). A type predicate: callers that check this returns `true` get
 * `quote` narrowed from `string | null` to `string`.
 */
export function quoteVerbatim(quote: string | null, pageText: string): quote is string {
  if (!quote) return false;
  const normalizedQuote = normAlnum(quote);
  if (!normalizedQuote) return false;
  const normalizedPage = normAlnum(pageText);
  if (normalizedPage.includes(normalizedQuote)) return true;

  // Split on sentence-boundary punctuation (or the "\n […] \n" separator
  // windowText joins spans with) BEFORE alnum-normalizing — normAlnum strips
  // the very punctuation this split depends on, so splitting the
  // already-normalized string would leave the boundary regex nothing to
  // match, silently defeating stitched-quote support. Normalize each
  // fragment independently afterward for the actual comparison.
  const fragments = quote
    .split(/(?<=[.!?;])\s+|\s+\[…\]\s+/)
    .map((fragment) => normAlnum(fragment))
    .filter((fragment) => fragment.length >= 15);
  return fragments.length > 0 && fragments.every((fragment) => normalizedPage.includes(fragment));
}

/** Relative tolerance for "these two MW figures are the same fact" —
 * shared between `quoteSupportsValue` (quote vs. extracted value) and
 * `isDuplicateOfRecordedSibling` (extracted value vs. the record's OTHER
 * capacityMw sub-field) so both checks agree on what counts as "the same
 * number." */
const RECONCILE_TOLERANCE = 0.05;

/**
 * Does `quote` actually evidence `value` (in MW)? Two independent checks:
 * `quote` must be a real span of the page (see `quoteVerbatim`), AND it must
 * carry a number+unit that, converted to MW, reconciles with `value` — this
 * is what rejects a bare "60" (a real span of almost any document, but
 * evidence for nothing) while still accepting "~48 MW", "1GW+", and
 * "Capacity 1,000 kW". Skip this for non-numeric fields (`energy.source`,
 * `energy.utility`) — use `quoteVerbatim` alone there.
 */
export function quoteSupportsValue(quote: string | null, value: number | null | undefined, pageText: string): boolean {
  if (!quoteVerbatim(quote, pageText)) return false;
  if (value === null || value === undefined || !Number.isFinite(value)) return false;
  const candidates = quotedMwValues(quote);
  if (candidates.length === 0) return false; // a bare number: real span, zero evidential content
  return candidates.some(
    (candidate) => Math.abs(candidate - value) / Math.max(Math.abs(candidate), Math.abs(value), 1) < RECONCILE_TOLERANCE
  );
}

// ============================================================================
// Stage 5.5 — duplicate-of-recorded-sibling guard (capacityMw only)
// ============================================================================

/**
 * True when an extracted `capacityMw.planned`/`capacityMw.operational` value
 * merely repeats the OTHER capacityMw sub-field ALREADY RECORDED on
 * `facility` (within `RECONCILE_TOLERANCE`). Structural failure mode, not a
 * model error: enrichment is fill-missing, so a record with only
 * `operational` set still queues `planned` as a gap; if the page states
 * exactly one capacity figure, the model correctly returns "the value the
 * page states" for whichever sub-field it was asked about — which is the
 * SAME number already recorded under the sibling sub-field, not a new fact.
 * Writing it into both sub-fields would make a facility look like it has a
 * planned expansion equal to its current size when no source says so.
 *
 * Compares ONLY against the facility's ALREADY-RECORDED sibling value —
 * never against another extraction from the same run (if BOTH sub-fields are
 * gaps, there is no recorded sibling to compare against, so this guard does
 * not fire; that is a different, out-of-scope case). Applies ONLY to the
 * capacityMw.planned/capacityMw.operational pair — `energy.*` fields have no
 * equivalent "same fact under a sibling name" risk and are left alone.
 */
export function isDuplicateOfRecordedSibling(
  facility: Facility,
  field: ExtractableField,
  value: number | string
): boolean {
  if (typeof value !== "number") return false;

  let recordedSibling: number | undefined;
  if (field === "capacityMw.planned") {
    recordedSibling = facility.capacityMw?.operational;
  } else if (field === "capacityMw.operational") {
    recordedSibling = facility.capacityMw?.planned;
  } else {
    return false;
  }
  if (recordedSibling === undefined) return false;

  return Math.abs(value - recordedSibling) / Math.max(Math.abs(value), Math.abs(recordedSibling), 1) < RECONCILE_TOLERANCE;
}

// ============================================================================
// Stage 6 — toEnrichmentIntents: emit the output contract submit-candidates.ts accepts
// ============================================================================

export interface AcceptedExtraction {
  field: ExtractableField;
  value: number | string;
  verbatimQuote: string;
  /** The specific cited source this value was extracted from. Different
   * fields on the same facility can legitimately come from different
   * sources (see Stage 6b) — this is what lets `toEnrichmentIntents` say
   * WHICH url supported WHICH value, not just "one of the facility's
   * sources, somewhere." */
  source: Source;
}

interface Track5EnrichmentFields {
  capacityMw?: { planned?: number; operational?: number };
  energy?: { source?: EnergySourceValue; utility?: string; onSiteGenerationMw?: number };
}

export interface Track5Candidate {
  enrichmentUpdate: {
    targetFacilityId: string;
    date: string;
    sources: Source[];
    fields: Track5EnrichmentFields;
  };
  provenance: {
    sources: string[];
    discoveredBy: string;
    runId: string;
    discoveredAt: string;
    note: string;
  };
}

/**
 * Merges one accepted extraction into `fields`. The runtime type of
 * `item.value` is guaranteed by `item.field` (enforced upstream by
 * `isValidValueForField` against the same field/value pairing) — mirrors the
 * field-tag-guarantees-shape pattern lib/enrichment-update.ts's own
 * `applyEnrichmentUpdate` uses when tsc can't otherwise narrow across a
 * discriminant.
 */
function assignField(fields: Track5EnrichmentFields, item: AcceptedExtraction): void {
  switch (item.field) {
    case "capacityMw.planned":
      fields.capacityMw = { ...fields.capacityMw, planned: item.value as number };
      break;
    case "capacityMw.operational":
      fields.capacityMw = { ...fields.capacityMw, operational: item.value as number };
      break;
    case "energy.onSiteGenerationMw":
      fields.energy = { ...fields.energy, onSiteGenerationMw: item.value as number };
      break;
    case "energy.source":
      fields.energy = { ...fields.energy, source: item.value as EnergySourceValue };
      break;
    case "energy.utility":
      fields.energy = { ...fields.energy, utility: item.value as string };
      break;
  }
}

/** MW threshold above which a `data_center`'s capacity extraction is flagged
 * for extra reviewer scrutiny rather than dropped — see the file header's
 * documented limit (mechanical grounding can't catch a real figure bound to
 * the wrong field; a very large number is exactly where that mistake is most
 * costly to leave unflagged). */
const REVIEW_THRESHOLD_MW = 500;

/**
 * Builds the `{ enrichmentUpdate, provenance }` candidate submit-candidates.ts
 * already accepts. Returns null for an empty `accepted` list (nothing to
 * emit). One candidate is still emitted per FACILITY even when its accepted
 * extractions came from several different sources (defect 4: fields are now
 * filled by reading through a facility's cited sources in order, not just the
 * first readable one) — `enrichmentUpdateIntentSchema` gives `capacityMw`/
 * `energy` no per-field `sourceRel` (only `jobs`/`community`/`subsidies` carry
 * one), so `sources[]` lists every DISTINCT source that contributed a value
 * (deduped by URL, `retrievedAt` stamped to `opts.date` since each was just
 * re-fetched), and `provenance.note` spells out field=value/quote/source per
 * extraction — the human reviewer's only way to tell which page backs which
 * fact when two different pages contributed two different fields.
 */
export function toEnrichmentIntents(
  facility: Facility,
  accepted: AcceptedExtraction[],
  opts: { runId: string; discoveredAt: string; date: string }
): Track5Candidate | null {
  if (accepted.length === 0) return null;

  const fields: Track5EnrichmentFields = {};
  for (const item of accepted) {
    assignField(fields, item);
  }

  const reviewFlagged =
    facility.facilityType === "data_center" &&
    accepted.some(
      (item) =>
        (item.field === "capacityMw.planned" || item.field === "capacityMw.operational") &&
        typeof item.value === "number" &&
        item.value >= REVIEW_THRESHOLD_MW
    );

  // Dedup by URL: several fields can legitimately come from the same page,
  // and each distinct source must appear exactly once in `sources[]`.
  const sourcesByUrl = new Map<string, Source>();
  for (const item of accepted) {
    if (!sourcesByUrl.has(item.source.url)) {
      sourcesByUrl.set(item.source.url, { ...item.source, retrievedAt: opts.date });
    }
  }
  const sources = [...sourcesByUrl.values()];

  const noteBody = accepted
    .map((item) => `${item.field}=${item.value} (quote: "${item.verbatimQuote}", source: ${item.source.url})`)
    .join("; ");
  const note = `${reviewFlagged ? `REVIEW: >=${REVIEW_THRESHOLD_MW}MW data_center — ` : ""}${noteBody}`;

  return {
    enrichmentUpdate: {
      targetFacilityId: facility.id,
      date: opts.date,
      sources,
      fields,
    },
    provenance: {
      sources: sources.map((s) => s.url),
      discoveredBy: "track5-extract",
      runId: opts.runId,
      discoveredAt: opts.discoveredAt,
      note,
    },
  };
}

// ============================================================================
// Pipeline driver — runExtract: the testable core (no CLI/process concerns)
// ============================================================================

export interface RunExtractDeps {
  fetchPageTextImpl: (url: string) => Promise<FetchPageTextResult>;
  callOllamaImpl: (opts: Omit<CallOllamaOptions, "fetchImpl">) => Promise<CallOllamaResult<ModelExtraction>>;
  now: () => Date;
}

export interface RunExtractOptions {
  fields: ExtractableField[];
  limit?: number;
  facilityId?: string;
  runId: string;
}

export interface RunExtractSummary {
  runId: string;
  facilitiesConsidered: number;
  /** PER-FIELD count — every (facility, field) gap `selectGaps` produced.
   * `extracted + prefiltered + modelNulls + modelUnavailable + quoteRejected
   * + duplicateOfSibling + schemaRejected + unreadable + fetchFailures` must
   * always sum to this. */
  gapsConsidered: number;
  /** PER-FIELD, not per-facility: incremented once for every requested field
   * on a facility where NO cited source could be fetched as readable
   * HTML/plain-text at all (i.e. once per gap that could not even be
   * attempted) — never once per facility. A facility-level increment here
   * would silently drop every field past the first on a multi-field facility
   * from every counter, breaking the `gapsConsidered` reconciliation above. */
  fetchFailures: number;
  /** PER-FIELD, not per-facility (see `fetchFailures`): every cited source
   * for the facility fetched successfully but yielded < MIN_READABLE_CHARS of
   * text (e.g. a JS-rendered page) — incremented once per requested field on
   * that facility. Kept distinct from `fetchFailures` (no source could be
   * fetched at all) and from `prefiltered` (a SUCCESSFUL fetch that
   * mechanically can't state the field), so a thin fetch is never silently
   * indistinguishable from a real "not mentioned" result. */
  unreadable: number;
  /** Total count of individual sources that fetched successfully AND cleared
   * MIN_READABLE_CHARS, across every facility processed — telemetry proving
   * the multi-source read (defect 4's fix) is actually reading more than one
   * page per facility, not just the count of facilities. */
  sourcesRead: number;
  /** Per-FACILITY-FIELD final outcome, not per-source events: a field
   * prefiltered out on one cited source but successfully extracted from the
   * next is counted once, under `extracted` — never under `prefiltered`. See
   * `processFacilitySources`. */
  prefiltered: number;
  modelNulls: number;
  modelUnavailable: number;
  quoteRejected: number;
  /** An extracted `capacityMw.planned`/`capacityMw.operational` merely
   * repeated the OTHER capacityMw sub-field already recorded on the facility
   * — see `isDuplicateOfRecordedSibling`. Kept distinct so this systematic,
   * structural false-positive never silently vanishes into `extracted` or
   * any other skip counter. */
  duplicateOfSibling: number;
  schemaRejected: number;
  extracted: number;
  /** MUST always be 0. Every gap is tracked in a single `Map<gapKey,
   * outcome>` (see `runExtract`) that starts every gap as `"unclassified"`
   * and is required to be overwritten exactly once before the run ends — a
   * gap that reaches the end of `runExtract` still `"unclassified"` is a
   * genuine accounting bug (the SAME class as defects 5/6/7, which each
   * independently broke the `gapsConsidered` reconciliation via a scattered
   * per-branch `summary.x++` that missed a path). Rather than silently
   * omitting such a gap from every bucket again, it is counted HERE, loudly,
   * with the exact facility/field logged via `console.error` — so a future
   * regression is visible in the summary itself instead of only showing up
   * as an unexplained shortfall days later. */
  unclassified: number;
  reviewFlagged: number;
  candidates: Track5Candidate[];
}

function isLikelyPdf(url: string): boolean {
  return /\.pdf(\?|#|$)/i.test(url);
}

/**
 * Floor below which a successful fetch is NOT a usable page — matches the
 * bench harness's own "thin skip" threshold
 * (plans/ollama-bench/fetch-pages.mjs). A JS-rendered page (e.g. an ArcGIS
 * embed) can resolve `fetchPageText`'s `{ ok: true }` while yielding almost
 * no server-rendered text — the fetch itself succeeded, but there is no real
 * content to check a claim against. Treating that as a normal "fetched fine,
 * field not mentioned" result would silently convert "we could not read this
 * source" into "this source does not state the fact" — the exact
 * couldn't-fetch-vs-isn't-there conflation this project has been bitten by
 * before. Never conflate the two.
 */
const MIN_READABLE_CHARS = 400;

/** Why a facility-field was NOT ultimately filled, recorded per-field so a
 * later source's attempt overwrites (or clears, on success) an earlier
 * source's reason rather than the caller double-counting per-source events —
 * see `processFacilitySources`. Named to match `RunExtractSummary`'s counter
 * keys exactly (`"modelNulls"`, not `"modelNull"`) so a reason string can be
 * used directly as a `GapOutcome` tag with no translation step to drift out
 * of sync. */
type FieldFailureReason = "prefiltered" | "modelUnavailable" | "modelNulls" | "quoteRejected" | "duplicateOfSibling";

interface FacilitySourcesResult {
  accepted: AcceptedExtraction[];
  /** Final failure reason per field that did NOT end up in `accepted` — a
   * field present in `accepted` never has an entry here (see the `delete`
   * calls below). Fields with NO entry and NOT in `accepted` mean no readable
   * source was ever found for the facility at all (caller checks
   * `sawAnyReadable` for that case first). */
  fieldFailureReason: Map<ExtractableField, FieldFailureReason>;
  sourcesRead: number;
  sawAnyReadable: boolean;
  sawAnyUnreadable: boolean;
}

/**
 * Defect 4's fix: iterates a facility's cited sources IN ORDER, reading as
 * many as it takes to fill every field in `fields` — not just the first
 * readable one. A field is dropped from consideration the moment it's
 * filled, so it is never re-attempted against a later source; the whole loop
 * stops early the moment every field is filled, or when sources are
 * exhausted. PDFs are skipped by extension up front (a belt-and-braces pair
 * with `fetchPageText`'s own content-type allowlist, which rejects PDFs
 * again even if the extension check misses one — e.g. a `.ashx` download
 * link). Never regexes a PDF's bytes (measured: produced a phantom "93, 4"
 * across ~10 records in an earlier pass of this project).
 */
async function processFacilitySources(
  facility: Facility,
  fields: ExtractableField[],
  deps: RunExtractDeps
): Promise<FacilitySourcesResult> {
  const unfilled = new Set(fields);
  const accepted: AcceptedExtraction[] = [];
  const fieldFailureReason = new Map<ExtractableField, FieldFailureReason>();
  let sourcesRead = 0;
  let sawAnyReadable = false;
  let sawAnyUnreadable = false;

  for (const source of facility.sources) {
    if (unfilled.size === 0) break; // every requested field is already filled — stop reading further sources
    if (isLikelyPdf(source.url)) continue;

    const fetchResult = await deps.fetchPageTextImpl(source.url);
    if (!fetchResult.ok) continue;
    if (fetchResult.text.length < MIN_READABLE_CHARS) {
      console.log(
        `thin: ${source.url} — fetched ${fetchResult.text.length} chars, below MIN_READABLE_CHARS=${MIN_READABLE_CHARS}; trying next source`
      );
      sawAnyUnreadable = true;
      continue;
    }

    sawAnyReadable = true;
    sourcesRead++;
    const windowed = windowText(fetchResult.text, facility.name, facility.location.city);
    console.log(`facility ${facility.id}: fetched ${source.url} (${windowed.mode}, ${windowed.text.length} chars)`);

    // Only the fields still unfilled are tried against this source — a field
    // already filled from an earlier source is never re-attempted.
    for (const field of [...unfilled]) {
      if (!prefilter(windowed.text, field)) {
        console.log(`skip: ${facility.id} ${field} — prefilter found no plausible mention on ${source.url}`);
        fieldFailureReason.set(field, "prefiltered");
        continue;
      }

      const outcome = await extractField(field, facility, windowed.text, deps);
      if (!outcome.ok) {
        console.log(`skip: ${facility.id} ${field} — model call unavailable on ${source.url} (${outcome.modelFailureReason})`);
        fieldFailureReason.set(field, "modelUnavailable");
        continue;
      }
      if (outcome.value === null) {
        console.log(
          `skip: ${facility.id} ${field} — model returned null on ${source.url} (${outcome.reasonIfNull ?? "no reason given"})`
        );
        fieldFailureReason.set(field, "modelNulls");
        continue;
      }

      if (!quoteVerbatim(outcome.verbatimQuote, windowed.text)) {
        console.log(`skip: ${facility.id} ${field} — quote is not a verbatim span of ${source.url}`);
        fieldFailureReason.set(field, "quoteRejected");
        continue;
      }
      // outcome.verbatimQuote is narrowed to `string` by the guard above.
      // The `as number` cast below is guaranteed by isNumericField(field)
      // exactly matching isValidValueForField's own numeric branch in
      // extractField — TS cannot see that runtime pairing across functions.
      if (isNumericField(field) && !quoteSupportsValue(outcome.verbatimQuote, outcome.value as number, windowed.text)) {
        console.log(`skip: ${facility.id} ${field} — quote does not reconcile with the extracted value on ${source.url}`);
        fieldFailureReason.set(field, "quoteRejected");
        continue;
      }
      if (isDuplicateOfRecordedSibling(facility, field, outcome.value)) {
        console.log(
          `skip: ${facility.id} ${field} = ${JSON.stringify(outcome.value)} on ${source.url} — duplicates the recorded sibling capacityMw value (existing capacityMw on record: ${JSON.stringify(facility.capacityMw)}); same fact re-read, not a new one`
        );
        fieldFailureReason.set(field, "duplicateOfSibling");
        continue;
      }

      console.log(`ok: ${facility.id} ${field} = ${JSON.stringify(outcome.value)} (source: ${source.url})`);
      accepted.push({ field, value: outcome.value, verbatimQuote: outcome.verbatimQuote, source });
      fieldFailureReason.delete(field); // filled — clear any earlier source's failure reason for it
      unfilled.delete(field); // never re-attempt this field against a later source
    }
  }

  return { accepted, fieldFailureReason, sourcesRead, sawAnyReadable, sawAnyUnreadable };
}

/**
 * Every possible terminal classification for a single (facility, field) gap,
 * PLUS the sentinel `"unclassified"` every gap starts as. Every member other
 * than `"unclassified"` is spelled to match a `RunExtractSummary` counter key
 * exactly, so tallying the outcome map into `summary` at the end of
 * `runExtract` needs no translation table to drift out of sync (the same
 * drift risk a per-branch `summary.x++` at every exit point already caused
 * twice — defects 5 and 6).
 */
type GapOutcome = "unclassified" | FieldFailureReason | "extracted" | "schemaRejected" | "unreadable" | "fetchFailures";

/**
 * Maps every `GapOutcome` to the `RunExtractSummary` counter it increments.
 * `Record<GapOutcome, ...>` is the load-bearing part, not the identity
 * mapping itself: TypeScript requires a property for EVERY member of the
 * `GapOutcome` union, so adding a new outcome without adding its entry here
 * fails `npx tsc --noEmit` at compile time. Without this, the tally loop's
 * `summary[outcome]++` would happily create a brand-new property on a
 * forgotten outcome instead of failing to build — a new outcome would
 * silently vanish from the reconciliation and misreport sweep yield, the
 * exact defect-5/defect-6 failure mode (a real exit path nobody wired a
 * counter for), just moved one level up. Do not "simplify" this back to a
 * bare `summary[outcome]++` — that reintroduces the very gap this guards.
 */
type NumericSummaryKey = {
  [K in keyof RunExtractSummary]: RunExtractSummary[K] extends number ? K : never;
}[keyof RunExtractSummary];

const OUTCOME_TO_SUMMARY_KEY: Record<GapOutcome, NumericSummaryKey> = {
  unclassified: "unclassified",
  prefiltered: "prefiltered",
  modelUnavailable: "modelUnavailable",
  modelNulls: "modelNulls",
  quoteRejected: "quoteRejected",
  duplicateOfSibling: "duplicateOfSibling",
  extracted: "extracted",
  schemaRejected: "schemaRejected",
  unreadable: "unreadable",
  fetchFailures: "fetchFailures",
};

function gapKey(facilityId: string, field: ExtractableField): string {
  return `${facilityId}::${field}`;
}

/**
 * Runs the full Track 5 pipeline over `facilities`. Gaps are grouped by
 * facility, then `processFacilitySources` reads through that facility's
 * cited sources — as many as it takes to fill every requested field, never
 * just the first readable one (defect 4) — before this function tallies the
 * final per-field outcome and builds one candidate per facility. Ollama
 * itself is strictly serial, so this processes one facility (and within it,
 * one source, and within that, one field) at a time; never fans out with
 * Promise.all.
 *
 * STRUCTURAL reconciliation guarantee (defect 7): every gap is tracked in a
 * single `outcomes` map, keyed by `gapKey`, that starts EVERY gap as
 * `"unclassified"` the moment `gapsConsidered` is computed. The loop below
 * only ever WRITES into that map (`outcomes.set(...)`) — it never increments
 * a `summary` counter directly. Counters are tallied from the map in exactly
 * ONE place, at the very end, by iterating every entry: this makes it
 * IMPOSSIBLE for a gap to reach the end of the function still uncounted
 * without it being visible as a non-zero `summary.unclassified`, because
 * there is no longer a scattered set of per-branch `summary.x++` calls that
 * a new code path can fail to reach. Defects 5 and 6 were each exactly that
 * failure mode — a real exit path that forgot to increment a counter — found
 * only by a human (or an invariant test) noticing the sum didn't match. This
 * makes the NEXT such omission self-evident in the summary itself instead of
 * requiring a fourth investigation.
 */
export async function runExtract(
  facilities: Facility[],
  opts: RunExtractOptions,
  deps: RunExtractDeps
): Promise<RunExtractSummary> {
  const summary: RunExtractSummary = {
    runId: opts.runId,
    facilitiesConsidered: 0,
    gapsConsidered: 0,
    fetchFailures: 0,
    unreadable: 0,
    sourcesRead: 0,
    prefiltered: 0,
    modelNulls: 0,
    modelUnavailable: 0,
    quoteRejected: 0,
    duplicateOfSibling: 0,
    schemaRejected: 0,
    extracted: 0,
    unclassified: 0,
    reviewFlagged: 0,
    candidates: [],
  };

  const targetFacilities = opts.facilityId ? facilities.filter((f) => f.id === opts.facilityId) : facilities;

  let gaps = selectGaps(targetFacilities, opts.fields);
  if (opts.limit !== undefined) {
    gaps = gaps.slice(0, opts.limit);
  }
  summary.gapsConsidered = gaps.length;

  // Single source of truth for "what ultimately happened to this gap" — see
  // the STRUCTURAL reconciliation guarantee in this function's doc-comment.
  const outcomes = new Map<string, GapOutcome>();
  for (const gap of gaps) {
    outcomes.set(gapKey(gap.facility.id, gap.field), "unclassified");
  }

  const byFacility = new Map<string, { facility: Facility; fields: ExtractableField[] }>();
  for (const gap of gaps) {
    const entry = byFacility.get(gap.facility.id);
    if (entry) {
      entry.fields.push(gap.field);
    } else {
      byFacility.set(gap.facility.id, { facility: gap.facility, fields: [gap.field] });
    }
  }
  summary.facilitiesConsidered = byFacility.size;

  const isoNow = deps.now().toISOString();
  const dateOnly = isoNow.slice(0, 10);

  for (const { facility, fields } of byFacility.values()) {
    const result = await processFacilitySources(facility, fields, deps);
    summary.sourcesRead += result.sourcesRead;

    if (!result.sawAnyReadable) {
      // `unreadable`/`fetchFailures` must reconcile against `gapsConsidered`
      // (a PER-FIELD count) the same way every other outcome does — classify
      // every requested field on this facility (i.e. every gap that could
      // not even be attempted), not just the facility as a whole.
      const outcome: GapOutcome = result.sawAnyUnreadable ? "unreadable" : "fetchFailures";
      if (result.sawAnyUnreadable) {
        console.log(
          `skip: ${facility.id} — every cited source fetched but yielded < ${MIN_READABLE_CHARS} chars of text (likely a JS-rendered or empty page) — this is NOT the same as "field not mentioned" (${fields.length} field(s) affected)`
        );
      } else {
        console.log(
          `skip: ${facility.id} — no cited source could be fetched as readable HTML/plain-text (${fields.length} field(s) affected)`
        );
      }
      for (const field of fields) {
        outcomes.set(gapKey(facility.id, field), outcome);
      }
      continue;
    }

    // Build + self-validate the candidate BEFORE the per-field tally below —
    // never emit a candidate submit-candidates.ts would itself reject.
    // targetFacilityId lives outside enrichmentUpdateIntentSchema (stripped
    // by submit-candidates.ts before parsing) — strip it here too so this
    // check exercises the exact same schema the downstream consumer applies.
    // Doing this FIRST (not after crediting `extracted`) is what makes
    // `schemaRejected` a real per-field final outcome instead of an
    // after-the-fact facility-level flag layered on top of fields already
    // counted as extracted: `enrichmentUpdateIntentSchema` validates
    // `capacityMw`/`energy` as whole sub-objects, so ONE invalid field (e.g.
    // a model-extracted `0`, which clears the quote gate but fails the
    // schema's `.positive()`) fails the WHOLE candidate — every field that
    // contributed to it must be reclassified `schemaRejected`, not left
    // double-counted under `extracted`.
    let candidate: Track5Candidate | null = null;
    let candidateFailedSchema = false;
    if (result.accepted.length > 0) {
      candidate = toEnrichmentIntents(facility, result.accepted, {
        runId: opts.runId,
        discoveredAt: isoNow,
        date: dateOnly,
      });
      if (candidate) {
        const intentBody = Object.fromEntries(
          Object.entries(candidate.enrichmentUpdate).filter(([key]) => key !== "targetFacilityId")
        );
        const validation = enrichmentUpdateIntentSchema.safeParse(intentBody);
        if (!validation.success) {
          console.log(
            `skip: ${facility.id} — built candidate failed enrichmentUpdateIntentSchema validation: ${validation.error.issues[0]?.message ?? "unknown validation error"} (${result.accepted.length} field(s) affected)`
          );
          candidateFailedSchema = true;
          candidate = null;
        }
      }
    }

    // Classify the FINAL per-field outcome now — a field prefiltered on
    // source 1 but extracted from source 2 lands in `extracted`, never
    // `prefiltered`; a field whose candidate failed schema validation lands
    // in `schemaRejected`, never `extracted`. Every branch below WRITES the
    // gap's outcome into the map — none increments `summary` directly.
    const extractedFields = new Set(candidateFailedSchema ? [] : result.accepted.map((item) => item.field));
    const schemaRejectedFields = new Set(candidateFailedSchema ? result.accepted.map((item) => item.field) : []);
    for (const field of fields) {
      const key = gapKey(facility.id, field);
      if (extractedFields.has(field)) {
        outcomes.set(key, "extracted");
        continue;
      }
      if (schemaRejectedFields.has(field)) {
        outcomes.set(key, "schemaRejected");
        continue;
      }
      const reason = result.fieldFailureReason.get(field);
      if (reason === undefined) {
        // Leaves this gap as "unclassified" rather than silently skipping it
        // — the whole point of the structural rewrite is that this case is
        // now visible in `summary.unclassified` and this log line, instead
        // of vanishing from every counter the way defects 5/6/7 each did.
        console.error(`UNCLASSIFIED GAP: ${key} — no recorded outcome despite a readable source; this is a bug`);
        continue;
      }
      outcomes.set(key, reason);
    }

    if (!candidate) continue;

    if (candidate.provenance.note.startsWith("REVIEW:")) summary.reviewFlagged++;
    summary.candidates.push(candidate);
  }

  // Single tally point: every gap's final entry in `outcomes` is counted
  // exactly once here. `"unclassified"` entries are counted (loudly, via the
  // console.error above) rather than thrown — a bookkeeping bug should never
  // abort a real sweep, but it must never be silent either.
  for (const outcome of outcomes.values()) {
    summary[OUTCOME_TO_SUMMARY_KEY[outcome]]++;
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
 * Parses `--fields`. No flag at all (`raw === undefined`) means "every
 * field" — the documented default. But once an operator DOES pass `--fields`,
 * every token in it must be a recognized `ExtractableField`: silently
 * substituting the full set on a typo (the original bug here) turned a
 * one-field request into a 5x-larger sweep that included the two fields the
 * bench measured as NOT safe to ship (`capacityMw.planned` P=75%,
 * `energy.onSiteGenerationMw` P=50%). Throws (not `process.exit` directly) so
 * this stays a pure, testable function — `main()`'s existing
 * `.catch(err => { console.error(err); process.exit(1); })` chain reports and
 * exits for a real CLI invocation.
 */
export function parseFieldsArg(raw: string | undefined): ExtractableField[] {
  if (raw === undefined) return [...EXTRACTABLE_FIELDS];
  const requested = raw
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  const invalid = requested.filter((f) => !(EXTRACTABLE_FIELDS as readonly string[]).includes(f));
  if (invalid.length > 0) {
    throw new Error(
      `--fields: unrecognized field name(s): ${invalid.join(", ")}. Valid fields are: ${EXTRACTABLE_FIELDS.join(", ")}.`
    );
  }
  return requested as ExtractableField[];
}

function parseArgs(argv: string[]): CliArgs {
  let outPath: string | undefined;
  let limit: number | undefined;
  let fields: ExtractableField[] = [...EXTRACTABLE_FIELDS];
  let facilityId: string | undefined;
  let runId = `track5-${Date.now()}`;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--out") {
      outPath = argv[++i];
    } else if (flag.startsWith("--out=")) {
      outPath = flag.slice("--out=".length);
    } else if (flag === "--limit") {
      const parsed = Number(argv[++i]);
      limit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
    } else if (flag.startsWith("--limit=")) {
      const parsed = Number(flag.slice("--limit=".length));
      limit = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
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
 * pattern as submit-candidates.ts's/existing-facilities.ts's own loader
 * (not shared into a common module — out of scope for this script). */
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

function printSummary(summary: RunExtractSummary): void {
  const { candidates, ...rest } = summary;
  console.log(JSON.stringify({ ...rest, candidateCount: candidates.length }, null, 2));
}

/**
 * Constructs the real fetch/Ollama implementations. Called ONLY from inside
 * `main()`, never at module scope — mirrors submit-candidates.ts's
 * `buildRealVerifyImpl` doc-comment: importing this module for tests must
 * never open a socket, and only `main()` (guarded by the `isMain` check
 * below) can ever reach this function at all.
 */
function buildRealDeps(): RunExtractDeps {
  return {
    fetchPageTextImpl: (url) => fetchPageText(url, { fetchImpl: fetch }),
    callOllamaImpl: (opts) => callOllama<ModelExtraction>({ ...opts, fetchImpl: fetch }),
    now: () => new Date(),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
  const facilities = await loadFacilities(baseUrl);

  const summary = await runExtract(
    facilities,
    { fields: args.fields, limit: args.limit, facilityId: args.facilityId, runId: args.runId },
    buildRealDeps()
  );

  if (!args.outPath) {
    // Dry run is the DEFAULT: print a summary, write nothing.
    console.log("DRY RUN (no --out given) — nothing written.");
    printSummary(summary);
    return;
  }

  mkdirSync(path.dirname(path.resolve(args.outPath)), { recursive: true });
  writeFileSync(args.outPath, JSON.stringify(summary.candidates, null, 2));
  console.log(`wrote ${summary.candidates.length} candidate(s) to ${args.outPath}`);
  printSummary(summary);
}

// Only run the CLI when this file is executed directly, not when its
// functions are imported by the test suite — matches submit-candidates.ts's
// isMain guard.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
