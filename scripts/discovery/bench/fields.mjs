// Shared field-kind declarations for the field-extraction bench -- imported by BOTH
// run.mjs (builds the model prompt) and rescore.mjs (scores the result).
//
// Precedent: quote.mjs is a shared module for exactly this reason ("a gate
// bug must be fixable without re-spending a model run" / "so rescore.mjs
// can RECOMPUTE it"). This module exists so the field-kind/vocabulary map
// can't drift between the file that prompts the model and the file that
// scores it -- declare it ONCE, here, and import it on both sides.

export const KIND = {
  NUMERIC: "numeric",
  ENUM: "enum",
  TEXT: "text",
};

// field -> kind. The four existing capacity/generation fields stay NUMERIC
// (scored via the original num()/close() 5%-tolerance path, unchanged).
export const FIELD_KINDS = {
  capacityAny: KIND.NUMERIC,
  capacityPlanned: KIND.NUMERIC,
  capacityOperational: KIND.NUMERIC,
  onSiteGenerationMw: KIND.NUMERIC,
  coolingType: KIND.ENUM,
  energySource: KIND.ENUM,
  energyUtility: KIND.TEXT,
};

/** kind for a field, defaulting to NUMERIC for anything undeclared -- keeps
 * pre-existing behaviour for any field this map doesn't yet know about. */
export function fieldKind(field) {
  return FIELD_KINDS[field] ?? KIND.NUMERIC;
}

// Closed vocabularies for ENUM fields. Copied from lib/schema.ts:
//   coolingType  <- waterSchema.coolingType   (the DATA CENTER cooling
//                    system -- NOT miningSchema.coolingType, which is a
//                    separate field with its own "immersion"/"hydro" values
//                    and no "evaporative"/"closed_loop")
//   energySource <- energySchema.source
// Verified against lib/schema.ts on 2026-09-01: both match exactly.
export const FIELD_ENUM_VALUES = {
  coolingType: ["evaporative", "air", "closed_loop", "hybrid", "unknown"],
  energySource: ["grid", "on_site_gas", "nuclear", "solar", "wind", "hydro", "mixed", "other"],
};

export function isInVocabulary(normalizedValue, vocabulary) {
  // Array.isArray is not ceremony: a STRING vocabulary would silently fall
  // through to String.prototype.includes and do a SUBSTRING match instead of
  // an exact one — e.g. "air" would "match" the string "hybrid,air,unknown".
  // Fail closed on a wrong-typed argument rather than scoring against it.
  return Array.isArray(vocabulary) && vocabulary.includes(normalizedValue);
}

// ── Normalisation ───────────────────────────────────────────────────────

/** ENUM normaliser: lowercase, trim, collapse whitespace, treat "-" and
 * whitespace as "_" -- so "closed loop" / "Closed-Loop" / "CLOSED_LOOP"
 * all normalise to the single token "closed_loop". Returns null for
 * null/undefined/empty input (an abstention, not a value). */
export function normalizeEnum(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).toLowerCase().trim().replace(/\s+/g, " ").replace(/[\s-]/g, "_");
  return s || null;
}

/** TEXT normaliser: lowercase, trim, collapse internal whitespace, strip
 * trailing punctuation. Deliberately NOT fuzzy / edit-distance -- a fuzzy
 * matcher would make the bench's own scoring a source of error. A labeller
 * who needs a variant to match lists it in truth.json's accept<Field>
 * alternates array instead (e.g. "Georgia Power" / "Georgia Power
 * Company"), the same mechanism numeric fields already use. */
export function normalizeText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,;:!?]+$/, "");
  return s || null;
}

/** Normalised exact-match for ENUM fields. */
export function enumEquals(a, b) {
  const na = normalizeEnum(a);
  const nb = normalizeEnum(b);
  return na !== null && nb !== null && na === nb;
}

/** Normalised exact-match for TEXT fields. */
export function textEquals(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  return na !== null && nb !== null && na === nb;
}

// ── NUMERIC (moved here verbatim from rescore.mjs, unchanged, so the
// comparison logic for ALL three kinds is testable from one module rather
// than trapped inside rescore.mjs's main loop) ─────────────────────────────

/** Coerce a value to a number by pulling the first number-looking substring
 * out of it. Returns null if nothing numeric is found. */
export function numericValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  const m = String(v).match(/-?[\d,.]+/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** 5%-relative-tolerance numeric match. */
export function numericClose(a, b) {
  return a !== null && b !== null && Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1) < 0.05;
}
