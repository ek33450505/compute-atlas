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
 * `energy.utility`, `water.coolingType`. `energy.notes` is intentionally NOT
 * covered — generating prose from a small local model is a fabrication
 * surface this script does not open.
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
 *   5.5 semantic field-correctness guards (capacityMw only) — three checks
 *                          that catch a number correctly grounded on the page
 *                          (it passed the quote gate) but wrong for the FIELD
 *                          it was assigned to:
 *                            isOperationalStatusContradiction — rejects an
 *                              extracted capacityMw.operational when the
 *                              facility's own status isn't "operational".
 *                            isDuplicateOfRecordedSibling — drops an extracted
 *                              planned/operational value that merely repeats
 *                              the OTHER capacityMw sub-field ALREADY
 *                              RECORDED on the facility (same fact re-read,
 *                              not a new one).
 *                            detectSiblingValueCollision — drops BOTH
 *                              sub-fields when they are extracted fresh, in
 *                              the same run, and resolve to the same value —
 *                              the case above has no recorded sibling to
 *                              catch it against.
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
 * substitute for it. Stage 5.5's `isOperationalStatusContradiction` and
 * `detectSiblingValueCollision` close two SPECIFIC, mechanically-detectable
 * instances of this same limit (a status/field contradiction; the same
 * number written into both capacity sub-fields) — they do not close the
 * general gap.
 *
 * === WAYBACK FALLBACK — RECOVERING A BOT-WALLED OR DEAD DIRECT FETCH ===
 * Mirrors verify-fields.ts's own fallback (see that file's header for the
 * measured 27.2%-unreachable finding that motivated it — issue #228). When
 * (and ONLY when) a source's DIRECT fetch fails with `http_error` or
 * `network_error`, `processFacilitySources` retries via
 * `findWaybackSnapshotUrl` (wayback.ts, shared with verify-fields.ts and
 * verify-source.ts) and re-fetches the snapshot through the same
 * `fetchSourceText` router as any other URL — a `.pdf` snapshot URL therefore
 * still routes correctly with no extra work. Deliberately NEVER attempted for
 * `bad_content_type`/`too_large`/`pdf_extract_failed`/etc. (separate,
 * out-of-scope findings) or for a merely-thin direct fetch. THE TRAP (same as
 * verify-fields.ts): Wayback sometimes archives nothing but its own
 * navigation chrome, so the SAME `MIN_READABLE_CHARS` floor applied to a
 * direct fetch is applied to the archived text too, BEFORE it is ever handed
 * to the model — a chrome-only snapshot is treated exactly like the ordinary
 * thin-page branch (`unreadable`), never as "the field is unstated." An
 * accepted extraction sourced from an archived snapshot is tagged
 * `AcceptedExtraction.viaArchive`/`archiveUrl` — `source`/`sources[]` always
 * keep the ORIGINAL cited URL, never rewritten to the snapshot, and
 * `toEnrichmentIntents`'s reviewer note spells out which page was actually
 * read, since a human approving the candidate cannot re-check a citation that
 * itself 403s. A successful archived fetch counts as `sawAnyReadable` — the
 * systemic-collapse abort guard must not fire just because the LIVE URLs
 * happened to be bot-walled while the network itself is fine. Pacing/sleep
 * and the raw `fetchImpl` used for the Wayback availability lookup are
 * injectable on `RunExtractDeps` (`sleep`/`fetchImpl`), mirroring
 * `VerifyFieldsDeps` exactly, so no test ever actually waits or opens a
 * socket; `buildRealDeps()` wires the real implementations.
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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Facility, Source } from "../../lib/schema";
import { enrichmentUpdateIntentSchema } from "../../lib/enrichment-update";
import { callOllama, type CallOllamaOptions, type CallOllamaResult } from "./ollama-client";
import { fetchPageText, type FetchPageTextResult } from "./fetch-page-text";
import { fetchPdfText, type FetchPdfTextResult } from "./fetch-pdf-text";
import { findWaybackSnapshotUrl } from "./wayback";

// ============================================================================
// Fields covered
// ============================================================================

export const EXTRACTABLE_FIELDS = [
  "capacityMw.planned",
  "capacityMw.operational",
  "energy.onSiteGenerationMw",
  "energy.source",
  "energy.utility",
  "water.coolingType",
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

// Mirrors lib/schema.ts's waterSchema.coolingType enum exactly — kept as a
// local literal (rather than unwrapped from the zod schema) for a plain
// JSON-schema `enum` array, same rationale as ENERGY_SOURCE_VALUES above. If
// lib/schema.ts's enum ever changes, update this too. Order matters — it is
// the benched order (see FIELD_DESCRIPTIONS["water.coolingType"] below).
const COOLING_TYPE_VALUES = ["evaporative", "air", "closed_loop", "hybrid", "unknown"] as const;
type CoolingTypeValue = (typeof COOLING_TYPE_VALUES)[number];

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
    case "water.coolingType":
      return facility.water?.coolingType === undefined;
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

// Separator that can join a number to its unit in compound-adjective prose
// ("36-megawatt"). A real page (s97 bench, flexential-hillsboro-5-or) wrote
// this with U+2011 NON-BREAKING HYPHEN ("36‑megawatt"), not ASCII '-', and
// en/em dashes ("36–megawatt") are ordinary published-prose punctuation, not
// exotic — an ASCII-only `-?` silently missed all of them. That silence is
// most consequential HERE, in the prefilter: a page whose only capacity
// figure uses a Unicode dash never even reaches the model, and the resulting
// gap is indistinguishable from a page that genuinely never states capacity
// (see the file header's "couldn't-fetch-vs-isn't-there" distinction — this
// is the same conflation one level up).
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
// rejected as a broadening risk. Shared (not redefined) at Stage 5's
// NUM_UNIT_RE below, so both regexes stay in lockstep — quote-parity.test.ts
// fails loudly if only one is fixed.
const NUM_UNIT_DASH_CLASS = "[\\p{Pd}\\u2212\\u00AD\\u2043]";

// Deliberately includes kW/kilowatt alongside MW/megawatt/GW/gigawatt — a
// real page stated "Capacity 1,000 kW" and an MW-only regex would have
// skipped it entirely, never even reaching the model.
const POWER_UNIT_RE = new RegExp(
  `\\d[\\d,.]*\\s*${NUM_UNIT_DASH_CLASS}?\\s*(kw|kilowatts?|mw|megawatts?|gw|gigawatts?)\\b`,
  "iu"
);
const ENERGY_SOURCE_HINT_RE =
  /\b(grid power|on-?site gas|natural gas|nuclear|solar|wind|hydro(?:electric)?|renewable|behind-the-meter|fuel cell|diesel generator|power source|energy source|electricity (?:comes|is drawn) from)\b/i;
const ENERGY_UTILITY_HINT_RE =
  /\b(utility|utilities|electric (?:co(?:mpany|operative)?|cooperative)|power company|served by|serves the|energy provider|transmission (?:provider|operator)|distribution utility)\b/i;
const COOLING_TYPE_HINT_RE =
  /\b(cool(?:ing|ed)?|chiller|cooling tower|evaporative|adiabatic|closed[- ]loop|direct-to-chip|liquid cooling|dry cooler|air-cooled|water-cooled|waterless|zero water|water usage effectiveness|\bWUE\b)\b/i;

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
  if (field === "water.coolingType") return COOLING_TYPE_HINT_RE.test(text);
  return ENERGY_UTILITY_HINT_RE.test(text); // energy.utility
}

// ============================================================================
// Stage 3 — windowText: entity-anchored windowing for long documents
// ============================================================================

// Ported from scripts/discovery/bench/fetch-pages.mjs (s97) — see that file's
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

// water.coolingType's description below is NOT decoration — it is the
// measured artifact itself. Benched 2026-09-01 over 69 hand-labelled pages,
// TWICE, same model: a bare vocabulary list (no decision rule) scored
// P=53% / R=42% (only 4/12 closed_loop pages right); with the TIE-BREAKER
// rule below in the prompt, P=95% / R=95% (12/12). See
// docs/methodology.md#cooling-type and scripts/discovery/bench/run.mjs:60-73,
// which this string is transcribed from verbatim. Do not paraphrase, trim, or
// "clean up" this text — doing so silently reverts to the 53% version.
export const FIELD_DESCRIPTIONS: Record<ExtractableField, string> = {
  "capacityMw.planned":
    "the facility's PLANNED total capacity, in megawatts (MW) — the capacity once fully built out, whether or not it is online yet.",
  "capacityMw.operational":
    "the facility's CURRENTLY OPERATIONAL (already online) capacity, in megawatts (MW).",
  "energy.onSiteGenerationMw":
    "the facility's on-site power generation capacity, in megawatts (MW) — power the facility itself generates on-site, not grid power it draws.",
  "energy.source": `the facility's primary energy source. Classify it as EXACTLY ONE of: ${ENERGY_SOURCE_VALUES.join(", ")}. Return this classification string, or null if the page does not state it.`,
  "energy.utility": "the name of the utility company that serves (provides grid power to) the facility.",
  "water.coolingType":
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
    `Answer with EXACTLY ONE of these values: ${COOLING_TYPE_VALUES.join(", ")} -- or null if not stated for this facility.`,
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
  if (field === "water.coolingType") {
    return { type: ["string", "null"], enum: [...COOLING_TYPE_VALUES, null] };
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
export function isValidValueForField(field: ExtractableField, value: number | string | null): boolean {
  if (value === null) return true;
  if (field === "energy.source") {
    return typeof value === "string" && (ENERGY_SOURCE_VALUES as readonly string[]).includes(value);
  }
  if (field === "energy.utility") {
    return typeof value === "string";
  }
  if (field === "water.coolingType") {
    // `hybrid` is in the prompt vocabulary (dropping it would change the
    // benched prompt and invalidate the 95%/95% measurement) but is REFUSED
    // here: the 69-page corpus contains zero positive `hybrid` labels, so the
    // value is unmeasured. Measured 2026-09-01: with the rule in the prompt the
    // model emitted `hybrid` 0 times; all 5 emissions came from the rule-free
    // run and every one was wrong (3x true `closed_loop`, 1x ambiguous, 1x
    // true null). Refusing it here costs nothing today and fails closed if that
    // ever regresses. Remove this only when `hybrid` has bench labels.
    return typeof value === "string"
      && (COOLING_TYPE_VALUES as readonly string[]).includes(value)
      && value !== "hybrid";
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

// Ported from scripts/discovery/bench/quote.mjs (s97). See that file's header for
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
// Shares NUM_UNIT_DASH_CLASS (defined at Stage 2's POWER_UNIT_RE, above) so
// this regex and the prefilter's stay in lockstep rather than drifting apart
// under two independent `-?`s.
const NUM_UNIT_RE = new RegExp(
  `(\\d[\\d,.]*)\\s*${NUM_UNIT_DASH_CLASS}?\\s*(kw|kilowatts?|mw|megawatts?|gw|gigawatts?)\\b`,
  "giu"
);

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
// Stage 5.5 — semantic field-correctness guards (capacityMw only)
// ============================================================================

/**
 * Guard 1 — the quote gate (Stage 5) proves a number+unit genuinely appears
 * on the page; it never asks whether that number belongs in the FIELD it was
 * assigned to. A facility whose own `status` is not itself `"operational"`
 * cannot have `capacityMw.operational` — this is a contradiction in the data
 * model (see lib/status.ts's STATUS_ORDER, which has exactly ONE
 * operational-like value; there is no "partially_operational"), not a
 * judgement call. The project already enforces the sharpest instance of this
 * rule elsewhere (a `cancelled` facility omits `capacityMw` entirely); this
 * generalizes it to every non-operational status.
 *
 * Keys off STATUS, never `facilityType` — a `power_generation` plant is
 * exactly as capable of being operational or not as a `data_center` or
 * `crypto_mining` site. comanche-peak-nuclear (status "operational",
 * facilityType "power_generation", 1200 MW) is legitimate and does NOT need
 * a facilityType special-case to pass — checking `status` alone already lets
 * it through, since its status already reads "operational".
 *
 * Real examples (19 of 101 candidates, 2026-08-16 audit): iren-sweetwater-tx
 * (status "under_construction") extracted operational: 1400;
 * big-horn-data-hub-hardin-mt (status "cancelled", crypto_mining) extracted
 * operational: 100.
 *
 * `capacityMw.planned` is deliberately NOT checked here — a proposed or
 * cancelled facility can legitimately have HAD a planned figure before it
 * stalled or was scrapped; only claiming it is currently ONLINE is the
 * contradiction.
 *
 * DESIGN DECISION: rejects with the distinct `statusContradiction` outcome
 * rather than keeping the value under a forced `REVIEW:` note. A `REVIEW:`
 * note today means exactly one thing (`>=500MW` on a `data_center`, see
 * `REVIEW_THRESHOLD_MW`) — "unusually large, double-check the source."
 * Conflating that with "structurally contradicts this facility's own status
 * field" under the same prefix would blur two different classes of concern a
 * reviewer needs to tell apart. Unlike the sibling-collision guard below,
 * this one is not ambiguous about WHICH field is wrong — the record's own
 * status already says the facility is not operational, full stop — so there
 * is nothing left for a human to adjudicate that the tool hasn't already
 * resolved mechanically. Still fully VISIBLE, never silent: counted under
 * `statusContradiction` and logged per-field by the caller — never silently
 * dropped, and never silently rewritten to a different field/status (a
 * silent rewrite would be a NEW instance of the exact class of bug this
 * guard exists to catch).
 */
export function isOperationalStatusContradiction(facility: Facility, field: ExtractableField): boolean {
  return field === "capacityMw.operational" && facility.status !== "operational";
}

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

export interface SiblingValueCollisionResult {
  /** `accepted`, with the colliding pair removed (unchanged if no collision). */
  accepted: AcceptedExtraction[];
  /** 0, or exactly `["capacityMw.operational", "capacityMw.planned"]` when a
   * collision was found and removed. */
  collidedFields: ExtractableField[];
}

/**
 * Guard 2 — catches the SAME defect as `isDuplicateOfRecordedSibling`, one
 * step earlier: that guard only fires when the OTHER sub-field is already
 * RECORDED on the facility. When BOTH `capacityMw.operational` and
 * `capacityMw.planned` are gaps in the SAME run (550 facilities have
 * neither set), there is no recorded sibling to compare against — if the
 * source states exactly one capacity figure, the model correctly returns
 * "the value the page states" for BOTH fields it is separately asked about,
 * filling both sub-fields with the SAME number from ONE quote. That is not
 * two independent facts.
 *
 * Real examples (8 of 101 candidates, all from a single quote per facility):
 * google-haskell-county-tx — quote "Capacity 640 MW PV + 1.3 GWh BESS" (a
 * SOLAR FARM + battery spec, not data-centre IT load) filled BOTH
 * operational and planned with 640; qts-ashburn-2 — "75 MW+ current planned
 * capacity" (the source itself SAYS planned) filled both with 75;
 * powerhouse-abx-1-va — "Max Utility MW Capacity: 60 MW" filled both with 60.
 *
 * DESIGN DECISION: drops BOTH fields, rather than keeping either one (even
 * REVIEW-flagged). Three reasons: (1) symmetry — `isDuplicateOfRecordedSibling`
 * already established, in this exact file, that "the same value in both
 * capacity sub-fields is not two independent facts" is handled by DROPPING,
 * not by flagging; treating the within-run case differently from the
 * recorded-sibling case, for the identical underlying defect, would be an
 * inconsistent rule. (2) the real examples above show BOTH numbers can be
 * wrong at once (the google example is a solar-farm figure under either
 * field name) — REVIEW-flagging would still ship exactly
 * `capacityMw: { planned: 640, operational: 640 }` into the pending queue,
 * the SAME shape as the defect this guard exists to prevent, betting a
 * reviewer notices by inspection what a dedicated audit was needed to find
 * in the first place. (3) this project's correctness-over-throughput
 * priority favors making NO claim over shipping two claims neither of which
 * has independent support. Still fully VISIBLE, never silent: counted under
 * the distinct `siblingCollision` outcome (one per field, so 2 per
 * collision) and logged by the caller with BOTH fields' value, quote, and
 * source in one line — a dropped fact is only recoverable if the evidence
 * that produced it survives in the log, not just the field name.
 *
 * Uses `RECONCILE_TOLERANCE` — not a second tolerance constant — the same
 * "these two MW figures are the same fact" threshold every other reconciler
 * in this file already shares.
 */
export function detectSiblingValueCollision(accepted: AcceptedExtraction[]): SiblingValueCollisionResult {
  const operational = accepted.find((item) => item.field === "capacityMw.operational");
  const planned = accepted.find((item) => item.field === "capacityMw.planned");
  if (!operational || !planned || typeof operational.value !== "number" || typeof planned.value !== "number") {
    return { accepted, collidedFields: [] };
  }

  const reconciles =
    Math.abs(operational.value - planned.value) / Math.max(Math.abs(operational.value), Math.abs(planned.value), 1) <
    RECONCILE_TOLERANCE;
  if (!reconciles) return { accepted, collidedFields: [] };

  return {
    accepted: accepted.filter((item) => item.field !== "capacityMw.operational" && item.field !== "capacityMw.planned"),
    collidedFields: ["capacityMw.operational", "capacityMw.planned"],
  };
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
   * sources, somewhere." Always the ORIGINAL cited source — see
   * `viaArchive`/`archiveUrl` below, never rewritten to a Wayback URL. */
  source: Source;
  /** True when this value was read from a Wayback snapshot because the cited
   *  URL was unreachable — weaker evidence than a live read, and the human
   *  reviewer cannot re-check the citation directly. See the file header's
   *  WAYBACK FALLBACK section. */
  viaArchive?: boolean;
  /** The snapshot actually read, set only alongside `viaArchive`. `source`
   *  above always remains the ORIGINAL cited URL. */
  archiveUrl?: string;
}

interface Track5EnrichmentFields {
  capacityMw?: { planned?: number; operational?: number };
  energy?: { source?: EnergySourceValue; utility?: string; onSiteGenerationMw?: number };
  water?: { coolingType?: CoolingTypeValue };
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
    case "water.coolingType":
      fields.water = { ...fields.water, coolingType: item.value as CoolingTypeValue };
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

  // A value read via an archived Wayback snapshot says so explicitly — a
  // human reviewer clicking `source.url` on an archive-recovered item would
  // otherwise hit the same 403/bot-wall the direct fetch did and be unable to
  // verify the value they're approving. Non-archived items are formatted
  // exactly as before this field existed (see the file header's WAYBACK
  // FALLBACK section).
  const noteBody = accepted
    .map((item) => {
      const base = `${item.field}=${item.value} (quote: "${item.verbatimQuote}", source: ${item.source.url}`;
      return item.viaArchive ? `${base}, read via archive: ${item.archiveUrl})` : `${base})`;
    })
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

/** The two fetchers `fetchSourceText` routes a source URL to, shared verbatim
 * by `verify-fields.ts` so that tool's PDF handling can never drift from this
 * one's — see `fetchSourceText`'s doc-comment for the routing rule itself. */
export interface SourceFetchDeps {
  fetchPageTextImpl: (url: string) => Promise<FetchPageTextResult>;
  /** Required, not optional: an optional field would default to silently
   * skipping every PDF source, which is exactly the silent-no-op failure
   * family this pipeline exists to prevent. Making it required forces every
   * `SourceFetchDeps` construction site (real or test) to decide what happens
   * to PDF sources instead of inheriting a default nobody chose. */
  fetchPdfTextImpl: (url: string) => Promise<FetchPdfTextResult>;
}

/**
 * Atomically writes `data` as JSON to `filePath`: writes to `<filePath>.tmp`
 * then `renameSync`s over the destination. `rename` is atomic on the same
 * filesystem, so a crash mid-write can never leave a truncated/invalid JSON
 * file where a valid one previously existed — the property `checkpoint`
 * (see `RunExtractDeps`) depends on. Callers are responsible for `mkdirSync`
 * -ing the destination directory first; this function does not create
 * directories.
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

export interface RunExtractDeps extends SourceFetchDeps {
  callOllamaImpl: (opts: Omit<CallOllamaOptions, "fetchImpl">) => Promise<CallOllamaResult<ModelExtraction>>;
  now: () => Date;
  /**
   * Optional crash-durability hook. When present, called once per facility
   * processed (never per gap — write volume must stay sane over a ~17h
   * sweep) with the summary accumulated so far, so a hard crash (OOM, the
   * machine sleeping, Ollama dying, ^C) loses at most one facility's worth of
   * work instead of the entire run. Wired by `main()` ONLY when `--out` is
   * set — a dry run must still write nothing. Distinct from the final write
   * in `main()`, which remains the authoritative last word regardless of
   * this hook's presence. A checkpoint failure must never abort the sweep —
   * callers should catch and log, not throw.
   */
  checkpoint?: (summary: RunExtractSummary) => void;
  /**
   * Paces Wayback availability lookups (see `WAYBACK_LOOKUP_PACING_MS`) so a
   * full sweep doesn't hammer archive.org. Injectable so no test ever
   * actually waits — falls back to a real `setTimeout`-backed sleep
   * (`realSleep`) when omitted; `buildRealDeps()` wires it explicitly anyway.
   * Mirrors `VerifyFieldsDeps.sleep` exactly.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Raw fetch, used ONLY to query the Wayback Machine's `/wayback/available`
   * endpoint (via `findWaybackSnapshotUrl`, wayback.ts) — mirrors
   * `VerifyFieldsDeps.fetchImpl` for the same reason: `fetchPageTextImpl`/
   * `fetchPdfTextImpl` enforce guards this trusted, fixed host doesn't need,
   * and a content-type allowlist that would reject its JSON response
   * outright. Defaults to the global `fetch` in production; tests should
   * always inject their own mock.
   */
  fetchImpl?: typeof fetch;
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
   * + duplicateOfSibling + statusContradiction + siblingCollision +
   * schemaRejected + unreadable + fetchFailures + abortedUnprocessed` must
   * always sum to this — on a normal (non-aborted) run `abortedUnprocessed`
   * is simply 0. */
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
  /** An extracted `capacityMw.operational` was rejected because the
   * facility's own `status` is not itself `"operational"` — see
   * `isOperationalStatusContradiction`. Kept distinct for the same reason as
   * `duplicateOfSibling`: a systematic, structural contradiction must never
   * silently vanish into `extracted` or any other skip counter. */
  statusContradiction: number;
  /** Both `capacityMw.operational` and `capacityMw.planned` were extracted
   * fresh in the SAME run and resolved to the same value (within
   * `RECONCILE_TOLERANCE`) — see `detectSiblingValueCollision`. Distinct
   * from `duplicateOfSibling`, which compares against an ALREADY-RECORDED
   * sibling: this fires when NEITHER sub-field was previously recorded, so
   * there was no recorded value for `duplicateOfSibling` to compare against
   * and one quote silently filled both gaps. Counted PER FIELD like every
   * other outcome here, so this counter increases by 2 (one for
   * `operational`, one for `planned`) for every collision found. */
  siblingCollision: number;
  schemaRejected: number;
  extracted: number;
  /** MUST always be 0 — including on an aborted run (see `aborted` below).
   * Every gap is tracked in a single `Map<gapKey, outcome>` (see
   * `runExtract`) that starts every gap as `"unclassified"` and is required
   * to be overwritten exactly once before the run ends — a gap that reaches
   * the end of `runExtract` still `"unclassified"` is a genuine accounting
   * bug (the SAME class as defects 5/6/7, which each independently broke the
   * `gapsConsidered` reconciliation via a scattered per-branch
   * `summary.x++` that missed a path). Rather than silently omitting such a
   * gap from every bucket again, it is counted HERE, loudly, with the exact
   * facility/field logged via `console.error` — so a future regression is
   * visible in the summary itself instead of only showing up as an
   * unexplained shortfall days later. An ABORTED run's genuinely-unprocessed
   * gaps are deliberately reclassified into `abortedUnprocessed` instead of
   * left here — conflating "the tool has a bug" with "the tool aborted on
   * purpose" would destroy the one thing this field exists to signal. */
  unclassified: number;
  /** PER-FIELD count of gaps that were never attempted at all because the
   * run aborted (see `aborted`) before reaching their facility — distinct
   * from `unclassified` (a real accounting bug) and from `fetchFailures` (a
   * facility that WAS attempted and failed). 0 on a normal run. */
  abortedUnprocessed: number;
  /** True iff `CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD` tripped and the
   * run stopped early (see `runExtract`'s doc-comment). A run can be
   * `aborted` and still have found real `candidates` — those are legitimate
   * and are never discarded; only the facilities never reached go into
   * `abortedUnprocessed`. Callers (`main()`) must still write `--out` and
   * print the summary on an aborted run, but must exit non-zero and must
   * never let this be mistaken for a complete, healthy sweep. */
  aborted: boolean;
  /** Human-readable reason, set iff `aborted` is true; `null` otherwise. */
  abortReason: string | null;
  reviewFlagged: number;
  candidates: Track5Candidate[];
}

function isLikelyPdf(url: string): boolean {
  return /\.pdf(\?|#|$)/i.test(url);
}

/**
 * Floor below which a successful fetch is NOT a usable page — matches the
 * bench harness's own "thin skip" threshold
 * (scripts/discovery/bench/fetch-pages.mjs). A JS-rendered page (e.g. an ArcGIS
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
type FieldFailureReason =
  | "prefiltered"
  | "modelUnavailable"
  | "modelNulls"
  | "quoteRejected"
  | "duplicateOfSibling"
  | "statusContradiction";

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
 * Source kinds that are a primary document (the filing/permit/queue entry
 * itself) rather than someone else's paraphrase of one. Everything else
 * (`press`, `osm`, `other`) is secondary.
 */
const PRIMARY_SOURCE_KINDS = new Set<Source["kind"]>(["permit", "filing", "iso_queue", "subsidy"]);

/**
 * F2's fix: reorders a facility's cited sources so primary documents
 * (`permit`, `filing`, `iso_queue`, `subsidy`) are read before secondary ones
 * (`press`, `osm`, `other`) — a press release's paraphrase of an engineering
 * detail can be wrong in ways the underlying filing isn't (e.g. novva-mesa-az:
 * a press release said "water-free air-cooling" while the City of Mesa filing
 * it paraphrased said "closed-loop water cooling"; whichever was cited first
 * used to win by accident of array order).
 *
 * Stable by construction (sorts on `[rank, originalIndex]`, not `rank`
 * alone): sources within the same group keep their original relative order.
 * Returns a new array — never mutates `facility.sources` — so
 * `processFacilitySources` iterating the copy cannot affect anything that
 * still reads `facility.sources` directly. Safe to reorder because
 * provenance is carried by source OBJECT REFERENCE, not position:
 * `toEnrichmentIntents` builds `sources[]` from `item.source` and
 * `provenance.note` prints `item.source.url` per accepted extraction, so
 * reading sources in a different order cannot misattribute which source
 * backed which value.
 */
export function sortSourcesPrimaryFirst(sources: Source[]): Source[] {
  return sources
    .map((source, index) => ({ source, index }))
    .sort((a, b) => {
      const rank = (s: Source) => (PRIMARY_SOURCE_KINDS.has(s.kind) ? 0 : 1);
      const rankDiff = rank(a.source) - rank(b.source);
      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    })
    .map(({ source }) => source);
}

/** Per-run mutable state threaded through `processFacilitySources` /
 * `fetchSourceText` so the `pdf_extractor_unavailable` warning below fires at
 * most once per `runExtract` call — never once per PDF source, which on a
 * PDF-heavy run would drown the log in copies of the same fact. A fresh
 * instance is created once per `runExtract` call (never module-scoped), so
 * it can never leak "already warned" state between independent runs or
 * tests. */
export interface FetchState {
  pdfExtractorUnavailableWarned: boolean;
}

/** Constructs a fresh `FetchState` — exported so `verify-fields.ts` (and any
 * other caller of the shared `fetchSourceText` router) creates its own
 * per-run instance the same way `runExtract` does below, rather than
 * hand-rolling `{ pdfExtractorUnavailableWarned: false }` at each call site.
 * See `FetchState`'s doc-comment: one per top-level run, never module-scoped. */
export function createFetchState(): FetchState {
  return { pdfExtractorUnavailableWarned: false };
}

/**
 * Fires a loud, one-time warning the first time any source in this run comes
 * back `pdf_extractor_unavailable` (poppler / `pdftotext` not installed).
 * Degraded, not fatal — the run does not abort for it, and this is the only
 * place the consequence is spelled out (every PDF source from here on will
 * simply fall through as an ordinary fetch failure), so it fires exactly
 * once per run rather than being buried inside a `fetch-failed:` line per
 * source.
 */
function warnIfPdfExtractorUnavailable(result: FetchPdfTextResult, fetchState: FetchState): void {
  if (result.ok || result.reason !== "pdf_extractor_unavailable" || fetchState.pdfExtractorUnavailableWarned) {
    return;
  }
  fetchState.pdfExtractorUnavailableWarned = true;
  console.error(
    "pdf-extractor-unavailable: pdftotext (poppler) is not installed — every PDF source in this run is going " +
      "unread. This run is DEGRADED, not aborted: PDF-only facilities will fall through as ordinary fetch " +
      "failures for every field they cite a PDF for. Install poppler (e.g. `brew install poppler`) and re-run " +
      "to read them."
  );
}

/**
 * Routes a single source URL to the right fetcher and returns a common
 * result shape (`ok`/`text`/`reason`/...) regardless of which one served it.
 * `.pdf`-extension URLs go straight to `fetchPdfTextImpl`. Everything else
 * goes to `fetchPageTextImpl` first — but many county-portal PDFs are served
 * from extensionless download endpoints (e.g. Legistar's
 * `View.ashx?M=F&ID=…&GUID=…`), so a `bad_content_type` result from
 * `fetchPageTextImpl` (it declared `application/pdf`, which the page fetcher
 * rejects on principle) is retried EXACTLY ONCE via `fetchPdfTextImpl`. If
 * that retry also fails, the ORIGINAL `bad_content_type` result is returned
 * — never the retry's own failure reason — so `fetchFailures` accounting
 * stays stable regardless of which path a source took; the retry attempt and
 * its outcome are logged either way so the choice is never silent.
 */
export async function fetchSourceText(
  url: string,
  deps: SourceFetchDeps,
  fetchState: FetchState
): Promise<FetchPageTextResult | FetchPdfTextResult> {
  if (isLikelyPdf(url)) {
    const result = await deps.fetchPdfTextImpl(url);
    warnIfPdfExtractorUnavailable(result, fetchState);
    return result;
  }

  const pageResult = await deps.fetchPageTextImpl(url);
  if (pageResult.ok || pageResult.reason !== "bad_content_type") {
    return pageResult;
  }

  console.log(`pdf-retry: ${url} — fetchPageTextImpl rejected bad_content_type; retrying via fetchPdfTextImpl`);
  const retryResult = await deps.fetchPdfTextImpl(url);
  warnIfPdfExtractorUnavailable(retryResult, fetchState);
  console.log(
    `pdf-retry-result: ${url} — ${retryResult.ok ? `ok, ${retryResult.text.length} chars` : `failed (${retryResult.reason})`}`
  );
  // Retry succeeded: use it. Retry failed too: surface the ORIGINAL
  // bad_content_type result, not the retry's reason — see doc-comment above.
  return retryResult.ok ? retryResult : pageResult;
}

/**
 * Real-world default for `RunExtractDeps.sleep` — a plain `setTimeout`
 * wrapped as a Promise. `buildRealDeps()` wires this explicitly, but
 * `attemptArchiveRecovery` also falls back to it directly (mirrors the
 * `deps.fetchImpl ?? fetch` pattern below) so any future caller that forgets
 * to wire `sleep` degrades to a real sleep rather than a crash. Mirrors
 * verify-fields.ts's own `realSleep`.
 */
async function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Paces Wayback availability lookups against archive.org — mirrors
 * verify-fields.ts's own `WAYBACK_LOOKUP_PACING_MS` (same value, same
 * rationale: a full sweep can generate on the order of hundreds of lookups
 * against a third-party host this project does not control). Applied BEFORE
 * each lookup in `attemptArchiveRecovery`, and ONLY when a lookup is
 * actually about to happen — a run with zero recoverable failures pays
 * nothing.
 */
const WAYBACK_LOOKUP_PACING_MS = 1_200;

/**
 * Attempts to recover a source whose DIRECT fetch failed with a genuine
 * transport failure (`http_error`/`network_error` — the caller,
 * `processFacilitySources`, checks this BEFORE ever calling in here; every
 * other failure reason is deliberately never routed to this function, see
 * the file header's WAYBACK FALLBACK section) by looking up and re-fetching
 * an archived Wayback snapshot of the same URL. Re-fetches through the SAME
 * `fetchSourceText` router as any other URL, so a `.pdf` snapshot URL routes
 * correctly with no extra work, and the shared `pdf_extractor_unavailable`
 * warning still fires at most once per run via the threaded `fetchState`.
 * Mirrors verify-fields.ts's own `attemptArchiveRecovery` exactly — kept as a
 * separate (not shared/imported) copy because it's typed against
 * `RunExtractDeps`, not `VerifyFieldsDeps`.
 *
 * Returns `null` when no snapshot exists at all. Otherwise returns the
 * snapshot URL found AND the result of fetching it — which may itself be
 * `{ ok: false }`; a snapshot existing does not guarantee it's fetchable.
 * The caller decides what each shape means for `viaArchive`/`archiveUrl` —
 * both `null` here and an `{ ok: false }` fetchResult mean "never actually
 * read a snapshot," so neither ever sets those fields.
 */
async function attemptArchiveRecovery(
  url: string,
  deps: RunExtractDeps,
  fetchState: FetchState
): Promise<{ archiveUrl: string; fetchResult: Awaited<ReturnType<typeof fetchSourceText>> } | null> {
  const sleep = deps.sleep ?? realSleep;
  await sleep(WAYBACK_LOOKUP_PACING_MS);

  const archiveUrl = await findWaybackSnapshotUrl(url, deps.fetchImpl ?? fetch);
  if (!archiveUrl) return null;

  const fetchResult = await fetchSourceText(archiveUrl, deps, fetchState);
  return { archiveUrl, fetchResult };
}

/**
 * Attempts every still-`unfilled` field against `windowedText` already
 * fetched from `source.url` — directly, or (when `archive` is set) via an
 * archived Wayback snapshot. Shared verbatim by both the direct-fetch and
 * archived-fetch success paths in `processFacilitySources` below, so an
 * accepted field's provenance tagging (`viaArchive`/`archiveUrl`) can never
 * drift between the two — mutates `unfilled`/`accepted`/`fieldFailureReason`
 * in place, mirroring the loop this replaced.
 */
async function extractFieldsFromReadableText(
  facility: Facility,
  source: Source,
  windowedText: string,
  unfilled: Set<ExtractableField>,
  accepted: AcceptedExtraction[],
  fieldFailureReason: Map<ExtractableField, FieldFailureReason>,
  deps: RunExtractDeps,
  archive?: { archiveUrl: string }
): Promise<void> {
  const archiveSuffix = archive ? `, via archive ${archive.archiveUrl}` : "";
  for (const field of [...unfilled]) {
    if (!prefilter(windowedText, field)) {
      console.log(`skip: ${facility.id} ${field} — prefilter found no plausible mention on ${source.url}${archiveSuffix}`);
      fieldFailureReason.set(field, "prefiltered");
      continue;
    }

    const outcome = await extractField(field, facility, windowedText, deps);
    if (!outcome.ok) {
      console.log(`skip: ${facility.id} ${field} — model call unavailable on ${source.url}${archiveSuffix} (${outcome.modelFailureReason})`);
      fieldFailureReason.set(field, "modelUnavailable");
      continue;
    }
    if (outcome.value === null) {
      console.log(
        `skip: ${facility.id} ${field} — model returned null on ${source.url}${archiveSuffix} (${outcome.reasonIfNull ?? "no reason given"})`
      );
      fieldFailureReason.set(field, "modelNulls");
      continue;
    }

    if (!quoteVerbatim(outcome.verbatimQuote, windowedText)) {
      console.log(`skip: ${facility.id} ${field} — quote is not a verbatim span of ${source.url}${archiveSuffix}`);
      fieldFailureReason.set(field, "quoteRejected");
      continue;
    }
    // outcome.verbatimQuote is narrowed to `string` by the guard above.
    // The `as number` cast below is guaranteed by isNumericField(field)
    // exactly matching isValidValueForField's own numeric branch in
    // extractField — TS cannot see that runtime pairing across functions.
    if (isNumericField(field) && !quoteSupportsValue(outcome.verbatimQuote, outcome.value as number, windowedText)) {
      console.log(`skip: ${facility.id} ${field} — quote does not reconcile with the extracted value on ${source.url}${archiveSuffix}`);
      fieldFailureReason.set(field, "quoteRejected");
      continue;
    }
    if (isOperationalStatusContradiction(facility, field)) {
      console.log(
        `skip: ${facility.id} ${field} = ${JSON.stringify(outcome.value)} on ${source.url}${archiveSuffix} — facility status is "${facility.status}", not "operational"; an operational-capacity figure contradicts the record`
      );
      fieldFailureReason.set(field, "statusContradiction");
      continue;
    }
    if (isDuplicateOfRecordedSibling(facility, field, outcome.value)) {
      console.log(
        `skip: ${facility.id} ${field} = ${JSON.stringify(outcome.value)} on ${source.url}${archiveSuffix} — duplicates the recorded sibling capacityMw value (existing capacityMw on record: ${JSON.stringify(facility.capacityMw)}); same fact re-read, not a new one`
      );
      fieldFailureReason.set(field, "duplicateOfSibling");
      continue;
    }

    console.log(`ok: ${facility.id} ${field} = ${JSON.stringify(outcome.value)} (source: ${source.url}${archiveSuffix})`);
    accepted.push({
      field,
      value: outcome.value,
      verbatimQuote: outcome.verbatimQuote,
      source,
      ...(archive ? { viaArchive: true, archiveUrl: archive.archiveUrl } : {}),
    });
    fieldFailureReason.delete(field); // filled — clear any earlier source's failure reason for it
    unfilled.delete(field); // never re-attempt this field against a later source
  }
}

/**
 * Defect 4's fix: iterates a facility's cited sources IN ORDER (F2: primary
 * documents first, see `sortSourcesPrimaryFirst`), reading as many as it
 * takes to fill every field in `fields` — not just the first readable one. A
 * field is dropped from consideration the moment it's filled, so it is never
 * re-attempted against a later source; the whole loop stops early the moment
 * every field is filled, or when sources are exhausted.
 *
 * F1's fix: PDFs are now READ, not skipped — routed through `fetchSourceText`
 * to `fetchPdfText`/`pdftotext -layout` (`.pdf`-extension URLs directly, plus
 * extensionless download links that turn out to declare `application/pdf`,
 * e.g. Legistar's `View.ashx?M=F&ID=…&GUID=…`). `-layout` mode specifically
 * matters, and not just inside `fetchPdfText` itself: measured on two real
 * source PDFs, raw `pdftotext` spliced hyphenated line-break words together
 * (`droughttolerant`, `highdemand`, `onstreet`) and broke a spec table's
 * `CRITICAL IT LOAD    240MW` into a detached label and a detached value;
 * `-layout` produced zero splice artifacts on either. That's why this loop
 * can safely regex a PDF's content at all — it only ever regexes the TEXT
 * `fetchPdfText` already extracted with `-layout`, still never a PDF's raw
 * bytes (regexing raw bytes measurably produced a phantom "93, 4" across ~10
 * records in an earlier pass of this project). A spliced (non-`-layout`)
 * extraction would not reproduce that mechanical garbage — it would instead
 * silently yield a false "the source does not state this" verdict, the same
 * couldn't-fetch/isn't-there conflation this project has separately lost
 * good citations to before. `-layout` is what keeps PDF reading from
 * reopening that failure family.
 */
async function processFacilitySources(
  facility: Facility,
  fields: ExtractableField[],
  deps: RunExtractDeps,
  fetchState: FetchState
): Promise<FacilitySourcesResult> {
  const unfilled = new Set(fields);
  const accepted: AcceptedExtraction[] = [];
  const fieldFailureReason = new Map<ExtractableField, FieldFailureReason>();
  let sourcesRead = 0;
  let sawAnyReadable = false;
  let sawAnyUnreadable = false;

  for (const source of sortSourcesPrimaryFirst(facility.sources)) {
    if (unfilled.size === 0) break; // every requested field is already filled — stop reading further sources

    if (process.env.TRACK5_DEBUG_MEM) {
      const mem = process.memoryUsage();
      const activeResources =
        typeof process.getActiveResourcesInfo === "function"
          ? process.getActiveResourcesInfo().length
          : ((process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.().length ?? -1);
      console.error(
        `[mem] before fetch rss=${(mem.rss / 1e6).toFixed(0)}MB heapUsed=${(mem.heapUsed / 1e6).toFixed(0)}MB activeResources=${activeResources} url=${source.url}`
      );
    }
    const fetchAttemptStart = Date.now();
    const fetchResult = await fetchSourceText(source.url, deps, fetchState);
    if (!fetchResult.ok) {
      // Previously silent — a per-source fetch failure never printed
      // anything at all, so `fetchPageText`'s (now-surfaced) errorCode/
      // errorMessage had nowhere to go and a systemic collapse produced zero
      // diagnostic trail. Log every failed attempt, not just the eventual
      // facility-level rollup.
      const detail =
        fetchResult.reason === "network_error"
          ? `network_error${fetchResult.errorCode ? `:${fetchResult.errorCode}` : ""}${fetchResult.errorMessage ? ` (${fetchResult.errorMessage})` : ""}`
          : `${fetchResult.reason}${fetchResult.httpStatus ? ` (status ${fetchResult.httpStatus})` : ""}`;

      if (fetchResult.reason === "http_error" || fetchResult.reason === "network_error") {
        const archived = await attemptArchiveRecovery(source.url, deps, fetchState);

        if (archived && archived.fetchResult.ok) {
          const archiveUrl = archived.archiveUrl;

          if (archived.fetchResult.text.length < MIN_READABLE_CHARS) {
            // Same MIN_READABLE_CHARS floor as an ordinary thin direct fetch
            // — a chrome-only Wayback snapshot must never be misread as "this
            // field is unstated." See the file header's WAYBACK FALLBACK
            // section; NEVER reaches extractField.
            sawAnyUnreadable = true;
            console.log(
              `thin: ${source.url} — direct fetch failed (${detail}); Wayback snapshot ${archiveUrl} fetched but only ${archived.fetchResult.text.length} chars (below MIN_READABLE_CHARS=${MIN_READABLE_CHARS}) — likely navigation chrome only; trying next source`
            );
            continue;
          }

          sawAnyReadable = true;
          sourcesRead++;
          const windowed = windowText(archived.fetchResult.text, facility.name, facility.location.city);
          console.log(
            `recovered-via-archive: ${facility.id} — ${source.url} — direct fetch failed (${detail}); reading Wayback snapshot ${archiveUrl} instead (${windowed.mode}, ${windowed.text.length} chars)`
          );
          await extractFieldsFromReadableText(facility, source, windowed.text, unfilled, accepted, fieldFailureReason, deps, {
            archiveUrl,
          });
          continue;
        }

        // No snapshot existed at all, or one was found but its own fetch
        // also failed — either way no archived text was ever actually read
        // (see `attemptArchiveRecovery`'s doc-comment), so this source stays
        // an ordinary fetch failure.
        const archiveDetail = archived
          ? `Wayback snapshot ${archived.archiveUrl} found but its own fetch also failed (${archived.fetchResult.ok ? "unknown" : archived.fetchResult.reason})`
          : "no Wayback snapshot available";
        console.log(`fetch-failed: ${facility.id} — ${source.url} — ${detail} — ${Date.now() - fetchAttemptStart}ms — ${archiveDetail}`);
        continue;
      }

      // Every other failure reason (bad_content_type / too_large /
      // pdf_extract_failed / pdf_extractor_unavailable / blocked /
      // redirect_limit) is deliberately NEVER routed to a Wayback recovery
      // attempt — see the file header's WAYBACK FALLBACK section.
      console.log(`fetch-failed: ${facility.id} — ${source.url} — ${detail} — ${Date.now() - fetchAttemptStart}ms`);
      continue;
    }
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
    await extractFieldsFromReadableText(facility, source, windowed.text, unfilled, accepted, fieldFailureReason, deps);
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
type GapOutcome =
  | "unclassified"
  | FieldFailureReason
  | "siblingCollision"
  | "extracted"
  | "schemaRejected"
  | "unreadable"
  | "fetchFailures"
  | "abortedUnprocessed";

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
  statusContradiction: "statusContradiction",
  siblingCollision: "siblingCollision",
  extracted: "extracted",
  schemaRejected: "schemaRejected",
  unreadable: "unreadable",
  fetchFailures: "fetchFailures",
  abortedUnprocessed: "abortedUnprocessed",
};

function gapKey(facilityId: string, field: ExtractableField): string {
  return `${facilityId}::${field}`;
}

/**
 * Abort threshold for CONSECUTIVE facilities whose sources ALL failed to
 * fetch at all (the `fetchFailures` branch below — never `unreadable`,
 * which means the fetch itself succeeded). Scattered link rot across a
 * curated dataset is real and expected; a long unbroken RUN of total fetch
 * failure across many different facilities/hosts is not — it is the
 * signature of a tool-level fetch collapse (e.g. a leaked/exhausted
 * connection pool or a broken network path), not a fact about the dataset.
 * Tripping this does NOT throw and does NOT discard work already done — see
 * `runExtract`'s doc-comment on `aborted`/`abortReason`/`abortedUnprocessed`.
 *
 * WHY 25 (evidence, not a round-number guess): facilities are processed
 * ALPHABETICALLY, which clusters same-operator sites (every `aws-*`
 * facility in a row, etc.) — a legitimate streak could in principle be
 * longer than a naive "scattered link rot" intuition suggests, if one
 * operator's domain is bot-walled or rate-limiting. Two real-data
 * measurements bound this: (1) the 2026-08-16 collapse incident itself
 * — 151 consecutive real facility fetches succeeded before the (still
 * unexplained, believed transient/environmental — see
 * scratchpad/track5/fetch-collapse.md) collapse, so ANY threshold at or
 * below 151 fires strictly before that point; (2) a 2026-08-16 debugging
 * session ran the REAL tool through 95 real, alphabetically-clustered
 * facilities (including a long run of `aws-*` sites) without EVER
 * observing a genuine all-sources-failed streak longer than 1 consecutive
 * facility — every fetch failure was scattered among facilities that DID
 * read at least one source. 25 is comfortably above the longest legitimate
 * streak actually observed (1) and comfortably below the collapse's own
 * scale (151+, in practice ~900), which is why it sits where it does; it is
 * NOT validated against a large deliberately-adversarial same-operator
 * bot-wall streak, so treat it as evidence-backed but not exhaustively
 * proven — if a future run false-triggers on a genuinely long same-operator
 * streak, that is new evidence to weigh, not a reason to reflexively raise
 * the number without recording why.
 */
export const CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD = 25;

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
 *
 * ABORT design (defect 2's fix, revised): if
 * `CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD` trips, this function does NOT
 * throw. It `break`s the facility loop, reclassifies every still-
 * `"unclassified"` gap (i.e. every facility never reached) into
 * `abortedUnprocessed`, sets `aborted`/`abortReason`, and returns a normal
 * summary — with every `candidates` entry found before the abort still
 * present. An earlier version of this guard threw, which silently discarded
 * every candidate already found (caught in review before shipping — see
 * scratchpad/track5/fetch-collapse.md). Throwing destroys legitimate work;
 * "the run must not report success" and "the run must not destroy what it
 * already accomplished" are separate requirements, and only the caller
 * (`main()`) — which still writes `--out` and prints the summary, but exits
 * non-zero — should decide what "not reporting success" means operationally.
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
    statusContradiction: 0,
    siblingCollision: 0,
    schemaRejected: 0,
    extracted: 0,
    unclassified: 0,
    abortedUnprocessed: 0,
    aborted: false,
    abortReason: null,
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

  // See CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD's doc-comment — counts
  // consecutive facilities (not gaps) whose sources ALL failed to fetch.
  // Reset to 0 on any facility that reads at least one source successfully
  // (readable OR merely thin/unreadable — either proves the tool itself is
  // still able to fetch).
  let consecutiveTotalFetchFailures = 0;

  // Set (not thrown) the moment CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD
  // trips — see this function's doc-comment on why an abort RETURNS a
  // flagged summary instead of throwing: candidates already found (and the
  // work already spent producing them) must survive a systemic-collapse
  // abort, not be discarded by it. `break`ing out of the loop below (rather
  // than throwing) is what preserves everything accumulated in `summary`
  // and `outcomes` so far.
  let abortReason: string | null = null;

  // One instance per `runExtract` call — see `FetchState`'s doc-comment —
  // so the pdf_extractor_unavailable warning's "once per run" guarantee
  // can never leak across independent runs or tests.
  const fetchState: FetchState = { pdfExtractorUnavailableWarned: false };

  for (const { facility, fields } of byFacility.values()) {
    try {
      const result = await processFacilitySources(facility, fields, deps, fetchState);
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
          consecutiveTotalFetchFailures = 0;
        } else {
          console.log(
            `skip: ${facility.id} — no cited source could be fetched as readable HTML/plain-text (${fields.length} field(s) affected)`
          );
          consecutiveTotalFetchFailures++;
        }
        // This facility's own gaps are real `fetchFailures`/`unreadable`
        // outcomes — classify them BEFORE the threshold check below, so the
        // triggering facility itself is counted correctly and only facilities
        // never reached at all end up in `abortedUnprocessed`.
        for (const field of fields) {
          outcomes.set(gapKey(facility.id, field), outcome);
        }
        if (!result.sawAnyUnreadable && consecutiveTotalFetchFailures >= CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD) {
          abortReason =
            `ABORTING: ${consecutiveTotalFetchFailures} consecutive facilities produced ZERO readable sources ` +
            `(most recent: ${facility.id}). This pattern is symptomatic of a SYSTEMIC fetch failure (e.g. a ` +
            `leaked/exhausted connection pool or a broken network path), not scattered link rot — a run that ` +
            `cannot fetch has not measured anything about the dataset and must not report success. Check the ` +
            `network_error errorCode/errorMessage fields fetchPageText now surfaces (scripts/discovery/fetch-page-text.ts) ` +
            `to diagnose the underlying cause before re-running. Do not raise this threshold to make the symptom go away.`;
          console.error(abortReason);
          break;
        }
        continue;
      }

      consecutiveTotalFetchFailures = 0;

      // Guard 2 (siblingCollision): a facility whose capacityMw.operational AND
      // capacityMw.planned were BOTH gaps this run, and BOTH resolved to the
      // SAME value, cannot both be independent facts — see
      // `detectSiblingValueCollision`'s doc-comment. Runs BEFORE candidate
      // construction so a colliding pair never reaches `toEnrichmentIntents` in
      // the first place — never `capacityMw: { planned: X, operational: X }`
      // built from a single ambiguous quote.
      const collision = detectSiblingValueCollision(result.accepted);
      if (collision.collidedFields.length > 0) {
        // A dropped fact is only RECOVERABLE if the value, quote, and source
        // that produced it survive in the log — printing only the field name
        // (as an earlier version of this line did) forces a human to re-run
        // the extraction just to learn what was thrown away, at which point a
        // genuinely correct value (e.g. a real `planned: 75` backed by its own
        // quote) is gone for good. Bring this up to the same evidentiary
        // standard as `isOperationalStatusContradiction`'s log line: id, field,
        // value, and source, PLUS the verbatim quote (truncated defensively —
        // nothing bounds a model quote's length) since the quote is what makes
        // a rejection line checkable in seconds instead of requiring a re-run.
        // Looked up from the PRE-filter `result.accepted` (not
        // `collision.accepted`, which has already had them removed) — each
        // field gets ITS OWN source/quote, never assumed shared, since the
        // two can legitimately come from DIFFERENT cited pages (defect 4).
        const truncateQuote = (quote: string, max = 200) => (quote.length > max ? `${quote.slice(0, max)}…` : quote);
        const op = result.accepted.find((item) => item.field === "capacityMw.operational");
        const pl = result.accepted.find((item) => item.field === "capacityMw.planned");
        console.log(
          `skip: ${facility.id} capacityMw.operational/capacityMw.planned — sibling collision: both resolved to the ` +
            `same value, no recorded sibling to compare against (see detectSiblingValueCollision). ` +
            `operational: value=${JSON.stringify(op?.value)} quote="${op ? truncateQuote(op.verbatimQuote) : "?"}" source=${op?.source.url ?? "?"}; ` +
            `planned: value=${JSON.stringify(pl?.value)} quote="${pl ? truncateQuote(pl.verbatimQuote) : "?"}" source=${pl?.source.url ?? "?"}`
        );
      }
      result.accepted = collision.accepted;
      const collidedFields = new Set(collision.collidedFields);

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
        if (collidedFields.has(field)) {
          outcomes.set(key, "siblingCollision");
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
    } finally {
      // Checkpoint exactly once per facility, regardless of which path this
      // iteration took (unreadable/fetchFailures, the systemic-abort `break`,
      // readable-but-no-candidate, schemaRejected, or a real candidate) — a
      // single call site in `finally` can never be silently bypassed by a
      // future `continue`/`break` added inside this loop body the way three
      // separate call sites could. `summary.candidates` is the only field
      // this checkpoint needs to be accurate (extract-fields.ts's other
      // counters are only tallied once, after this whole loop, from
      // `outcomes`), and the array is already correct here since the push
      // above runs inside `try` and completes before `finally` does. See
      // `RunExtractDeps.checkpoint`'s doc-comment.
      deps.checkpoint?.(summary);
    }
  }

  if (abortReason !== null) {
    summary.aborted = true;
    summary.abortReason = abortReason;
    // Every gap belonging to a facility the loop above never reached is
    // still sitting at the map's initial "unclassified" sentinel. That is
    // correct and expected on an abort — but `unclassified` in the summary
    // must stay reserved EXCLUSIVELY for "the tool has a real accounting
    // bug" (see its doc-comment), so reclassify every still-unclassified gap
    // into `abortedUnprocessed` here, explicitly, before the tally below.
    // Gaps belonging to facilities that WERE reached (including the
    // triggering facility itself) were already written into `outcomes`
    // above and are untouched by this loop.
    for (const [key, outcome] of outcomes) {
      if (outcome === "unclassified") outcomes.set(key, "abortedUnprocessed");
    }
  }

  // Single tally point: every gap's final entry in `outcomes` is counted
  // exactly once here. `"unclassified"` entries are counted (loudly, via the
  // console.error above) rather than thrown — a bookkeeping bug should never
  // abort a real sweep, but it must never be silent either. On an aborted
  // run every genuinely-unprocessed gap was already reclassified into
  // `abortedUnprocessed` just above, so `unclassified` staying 0 here is
  // still a meaningful guarantee, not something the abort path weakens.
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

/**
 * Fallback used when `--limit` is PRESENT on the command line but not
 * parseable as a positive integer (`--limit=abc`, `--limit=0`,
 * `--limit=-5`, an empty value). Kept as a named constant, not a bare
 * literal, so the "why 500" reasoning stays attached to the value.
 */
const INVALID_LIMIT_FALLBACK = 500;

/**
 * Parses a `--limit` value that was actually supplied. `limit === undefined`
 * means "no bound" downstream — see `if (opts.limit !== undefined) { gaps =
 * gaps.slice(0, opts.limit); }` — and that is the correct, deliberate
 * meaning of OMITTING `--limit` entirely (an operator asking for a full
 * sweep). `raw === undefined` here reflects exactly that omission, so it is
 * the only input allowed to return `undefined`.
 *
 * A PRESENT-but-invalid value must never collapse to that same `undefined`:
 * doing so is the bug this function exists to close — `--limit=abc` used to
 * silently produce an unbounded, ~12-hour sweep over the full gap set. Clamp
 * it to `INVALID_LIMIT_FALLBACK` instead, and say so loudly on stderr.
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
  let runId = `track5-${Date.now()}`;

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
    fetchPdfTextImpl: (url) => fetchPdfText(url, { fetchImpl: fetch }),
    callOllamaImpl: (opts) => callOllama<ModelExtraction>({ ...opts, fetchImpl: fetch }),
    now: () => new Date(),
    sleep: realSleep,
    fetchImpl: fetch,
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
    // of work instead of the entire ~17h run — see `RunExtractDeps.checkpoint`.
    // Wired ONLY when --out is set: a dry run must still write nothing.
    deps.checkpoint = (partial) => {
      try {
        atomicWriteJson(outPath, partial.candidates);
      } catch (err) {
        // Losing a checkpoint is survivable; killing a 17-hour sweep over a
        // transient write failure is not.
        console.error(`checkpoint write failed (continuing sweep): ${err instanceof Error ? err.message : String(err)}`);
      }
    };
  }

  const summary = await runExtract(
    facilities,
    { fields: args.fields, limit: args.limit, facilityId: args.facilityId, runId: args.runId },
    deps
  );

  // Write (or report dry-run) UNCONDITIONALLY, whether or not the run
  // aborted — an abort must not report success, but it must also not
  // discard candidates legitimately found before it tripped. See
  // `CONSECUTIVE_FETCH_FAILURE_ABORT_THRESHOLD`/`runExtract`'s "ABORT
  // design" doc-comment.
  if (!args.outPath) {
    // Dry run is the DEFAULT: print a summary, write nothing.
    console.log("DRY RUN (no --out given) — nothing written.");
  } else {
    mkdirSync(path.dirname(path.resolve(args.outPath)), { recursive: true });
    writeFileSync(args.outPath, JSON.stringify(summary.candidates, null, 2));
    console.log(`wrote ${summary.candidates.length} candidate(s) to ${args.outPath}`);
  }
  printSummary(summary);

  if (summary.aborted) {
    // Surface the abort prominently — the same reason is already inside the
    // printed summary JSON (`abortReason`), but a reader skimming console
    // output for a "wrote N candidates" line must not be able to mistake
    // this for a complete, healthy sweep.
    console.error(`\n${summary.abortReason}`);
    // process.exitCode (not process.exit()) so the writes/console output
    // above are guaranteed to flush before the process actually exits, and
    // so this is still the single non-zero-exit codepath Defect 2 requires
    // — no `return`/throw needed, Node exits with this code once main()'s
    // promise settles.
    process.exitCode = 1;
  }
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
