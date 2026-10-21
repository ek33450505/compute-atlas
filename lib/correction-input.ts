import type { CorrectableKey } from "@/lib/contribute-fields";
// Client-safe leaf: a type-only import and pure string handling, nothing else.
// The correction dialog imports it, so it must never grow a server-only import
// (see lib/lead-fields.guard.test.ts for the failure mode).

// ---------------------------------------------------------------------------
// Numbers — the dialog's number fields take what a person would actually type
// ("1,200", "1.2 GW", "$12.5M") and send the server a plain positive number.
// ---------------------------------------------------------------------------

export type ParsedNumber = { ok: true; value: number } | { ok: false; error: string };

// Zero is a number, but the server refuses it, so it gets its own message
// instead of the field's "enter a ... number" one.
const ZERO_ERROR = "Enter a number greater than 0.";

interface NumberFieldSpec {
  /** Accepted trailing unit (lower-case) -> power of ten it scales by. "" (no
   *  unit) is always 0. A Map, not a record: a typed "constructor" must not
   *  find an inherited key. */
  units: ReadonlyMap<string, number>;
  /** The server stores a count, so the scaled result must be a whole number
   *  (and a safe one: it rejects anything past Number.MAX_SAFE_INTEGER). */
  wholeNumber: boolean;
  /** Shown under the input, and referenced by the field's error. */
  hint: string;
  error: string;
}

const unitMap = (exponents: Record<string, number>): ReadonlyMap<string, number> =>
  new Map(Object.entries(exponents));

const CAPACITY_SPEC: NumberFieldSpec = {
  units: unitMap({ mw: 0, megawatt: 0, megawatts: 0, gw: 3, gigawatt: 3, gigawatts: 3 }),
  wholeNumber: false,
  hint: "In megawatts. 1.2 GW works too.",
  error: "Enter a number in megawatts, like 300 or 1.2 GW.",
};

const NUMBER_FIELD_SPECS: Partial<Record<CorrectableKey, NumberFieldSpec>> = {
  capacityOperationalMw: CAPACITY_SPEC,
  capacityPlannedMw: CAPACITY_SPEC,
  subsidies: {
    units: unitMap({
      k: 3,
      thousand: 3,
      m: 6,
      mm: 6,
      mn: 6,
      million: 6,
      b: 9,
      bn: 9,
      billion: 9,
    }),
    wholeNumber: false,
    hint: "In US dollars. 12.5M or 1.2B works too.",
    error: "Enter a dollar amount, like 12,500,000 or 12.5M.",
  },
  jobs: {
    units: unitMap({ k: 3 }),
    wholeNumber: true,
    hint: "Permanent jobs only.",
    error: "Enter a whole number, like 1,200.",
  },
};

/** The helper line under a correction field's number input, if it has one. */
export function correctionNumberHint(field: CorrectableKey): string | undefined {
  return NUMBER_FIELD_SPECS[field]?.hint;
}

// Commas only where a thousands separator belongs: "1,200" and "12,500,000"
// pass, "1,5" does not. A decimal comma would otherwise read as 15 instead of
// being refused.
const NUMBER_WITH_UNIT_RE = /^((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?|\.\d+)\s?([a-z]*)$/i;

/**
 * Parses what someone typed into a correction's number field. Trims, drops one
 * leading `$`, and collapses internal whitespace, then reads digits plus an
 * optional unit that THIS field allows (so "1.2 GW" is fine for capacity and an
 * error for jobs). The result is finite and > 0, as validateFieldValue in
 * lib/contribute.ts requires of every number field.
 */
export function parseCorrectionNumber(raw: string, field: CorrectableKey): ParsedNumber {
  const spec = NUMBER_FIELD_SPECS[field];
  if (!spec) return { ok: false, error: "Enter a number." };
  const fail: ParsedNumber = { ok: false, error: spec.error };

  const cleaned = raw.trim().replace(/^\$/, "").trim().replace(/\s+/g, " ");
  const match = NUMBER_WITH_UNIT_RE.exec(cleaned);
  if (!match) return fail;

  const unit = match[2].toLowerCase();
  const exponent = unit === "" ? 0 : spec.units.get(unit);
  if (exponent === undefined) return fail;

  // Scale on the decimal text ("16.1e3"), which JS parses to exactly 16100.
  // Multiplying floats (16.1 × 1000) gives 16100.000000000002, which fails the
  // whole-number check; rounding that away instead would clip real digits
  // past the 12th.
  const value = Number(`${match[1].replace(/,/g, "")}e${exponent}`);
  if (!Number.isFinite(value)) return fail;
  if (value <= 0) return { ok: false, error: ZERO_ERROR };
  if (spec.wholeNumber && !Number.isSafeInteger(value)) return fail;
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Source URLs
// ---------------------------------------------------------------------------

const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
// "example.com:8080/a": a dotted host and a numeric port, which HAS_SCHEME_RE
// would otherwise read as a scheme. Requiring the dot keeps "mailto:1@x.com",
// "javascript:0/a.b" and "ftp:21/x.org" out of it, so they stay unrewritten.
const HOST_PORT_RE = /^(?:[a-z0-9-]+\.)+[a-z0-9-]+:\d+(?:[/?#]|$)/i;

/**
 * Trims a pasted source link and adds `https://` when it was left off
 * ("example.com/a", "//example.com", "example.com:8080/a"). A value that
 * already has a scheme is returned as is, so the dialog and the server can
 * still reject `ftp:` and `javascript:` instead of this quietly rewriting them.
 */
export function normalizeSourceUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return trimmed;
  const hasSpace = /\s/.test(trimmed);
  if (!hasSpace && HOST_PORT_RE.test(trimmed)) return `https://${trimmed}`;
  if (HAS_SCHEME_RE.test(trimmed)) return trimmed;
  if (!hasSpace && trimmed.includes(".")) return `https://${trimmed.replace(/^\/+/, "")}`;
  return trimmed;
}

/** True for an absolute http(s) URL, the only kind the server accepts. */
export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
