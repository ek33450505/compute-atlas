import { STATUS_META, type Status } from "@/lib/status";
import { aiClassificationEnum, type Facility } from "@/lib/schema";

/**
 * Returns the maximum of operational/planned capacity in MW, or undefined if
 * the facility has no capacity data.
 */
export function getFacilityMaxMw(f: Facility): number | undefined {
  const operational = f.capacityMw?.operational;
  const planned = f.capacityMw?.planned;
  if (operational !== undefined && planned !== undefined) {
    return Math.max(operational, planned);
  }
  return operational ?? planned;
}

/**
 * Returns a human-readable capacity string:
 * - "150 MW"              when operational capacity is present
 * - "1,200 MW planned"    when only planned capacity is present
 * - "—"                   when no capacity data is available
 */
export function formatCapacity(f: Facility): string {
  const operational = f.capacityMw?.operational;
  const planned = f.capacityMw?.planned;
  if (operational !== undefined) {
    return `${operational.toLocaleString()} MW`;
  }
  if (planned !== undefined) {
    return `${planned.toLocaleString()} MW planned`;
  }
  return "—";
}

/**
 * Returns a location string in the form "City, ST" or just "ST" when city is
 * absent.
 */
export function formatLocation(f: Facility): string {
  const { city, state } = f.location;
  if (city) {
    return `${city}, ${state}`;
  }
  return state;
}

/**
 * Returns the human-readable status label from STATUS_META.
 */
export function formatStatusLabel(s: Status): string {
  return STATUS_META[s].label;
}

/**
 * Trailing legal-entity suffixes stripped when comparing an operator name
 * against a facility name for redundancy (see `isOperatorRedundant` below).
 * Anchored to the end of the string, preceded by a comma and/or whitespace,
 * with an optional trailing period — case-insensitive.
 */
const LEGAL_SUFFIX_RE =
  /[,\s]+(?:l\.?l\.?c\.?|llp|lp|inc\.?|incorporated|corp\.?|corporation|ltd\.?|limited|co\.?|company|holdings|group|plc)$/i;

/**
 * Strips trailing legal-entity suffixes (", Inc.", " LLC", " Holdings", ...)
 * from an organization name, looping until none remain — so a compound like
 * "Foo Holdings, LLC" fully reduces to "Foo" in one call. Mirrors the
 * suffix-normalization shape of `normalizeCounty` in lib/metros.ts, applied
 * to company names instead of county names.
 */
export function stripLegalSuffix(name: string): string {
  let current = name.trim();
  for (;;) {
    const stripped = current.replace(LEGAL_SUFFIX_RE, "").trim();
    if (stripped === current) return current;
    current = stripped;
  }
}

/**
 * True when a facility's name already conveys its operator, or vice versa
 * (e.g. name "Google Council Bluffs", operator "Google") — both sides are
 * run through `stripLegalSuffix` first so a trailing "Inc."/"LLC"/etc. can't
 * defeat the match (e.g. name "CleanSpark Dalton Bitcoin Mining Facility",
 * operator "CleanSpark, Inc."). Used to omit a redundant operator segment
 * from generated titles.
 */
export function isOperatorRedundant(name: string, operator: string): boolean {
  const nameLower = stripLegalSuffix(name).toLowerCase();
  const operatorLower = stripLegalSuffix(operator).toLowerCase();
  return nameLower.includes(operatorLower) || operatorLower.includes(nameLower);
}

/**
 * Per-type keywords that, if present in a facility's own name, already
 * convey its facilityType (e.g. name "... Bitcoin Mining Facility" conveys
 * crypto_mining) — deliberately a short, high-precision list rather than an
 * exhaustive one. Matched as case-insensitive substrings in `nameConveysType`.
 */
/** Escape a literal string for safe interpolation into a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TYPE_KEYWORDS: Record<Facility["facilityType"], string[]> = {
  data_center: ["data center", "datacenter", "data centre"],
  crypto_mining: ["mining", "miner"],
  power_generation: ["solar", "wind", "power plant", "power station", "generating station"],
};

/**
 * True when a facility's own name already conveys its facilityType — signals
 * a title generator can omit the redundant type-label segment. Used by
 * app/facilities/[slug]/page.tsx's generateMetadata.
 */
export function nameConveysType(
  name: string,
  facilityType: Facility["facilityType"]
): boolean {
  const nameLower = name.toLowerCase();
  // Match the keyword as a whole word, tolerating a plural "s" — a bare
  // substring test suppresses the type label on names that merely CONTAIN a
  // keyword inside a longer word ("Windsor"/"Winding" both contain "wind",
  // "Minerva" contains "miner", "Solaris" contains "solar"). The trailing
  // `s?` is what keeps "Data Centers" matching, which is why a plain \b
  // word-boundary test is not enough here.
  return TYPE_KEYWORDS[facilityType].some((keyword) =>
    new RegExp(`${escapeRegExp(keyword)}s?(?![a-z])`).test(nameLower)
  );
}

/** Human-readable labels for the aiClassification enum. */
export const AI_CLASSIFICATION_LABELS: Record<string, string> = {
  confirmed: "AI-specific",
  likely: "Likely AI-specific",
  mixed_use: "Mixed-use",
};

/**
 * Confidence-tier labels for the aiClassification enum, for aggregate/breakdown
 * contexts where the page already establishes the AI framing (/ai, /stats,
 * /states/[state], the admin form). Per-facility contexts use
 * {@link AI_CLASSIFICATION_LABELS} above, which is self-describing ("AI-specific").
 */
export const AI_CLASSIFICATION_CONFIDENCE_LABELS: Record<
  (typeof aiClassificationEnum.options)[number],
  string
> = {
  confirmed: "Confirmed",
  likely: "Likely",
  mixed_use: "Mixed use",
};

/** Human-readable labels for the confidence enum. */
export const CONFIDENCE_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  reported: "Reported",
  rumored: "Rumored",
};

/**
 * Formats a USD value using compact notation (e.g. "$3.5B", "$450M", "$2.9M").
 * Uses at most one decimal digit.
 */
export function formatUsdCompact(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
    // Without this, ICU's compact-notation trailing-zero handling varies by
    // Node/ICU version — e.g. "$450M" locally vs "$450.0M" on Node 22 in CI.
    // stripIfInteger normalizes this: the fraction is dropped only when the
    // compact value is a whole number, so "$3.5B"/"$2.9M" are unaffected.
    trailingZeroDisplay: "stripIfInteger",
  }).format(n);
}

/** Formats megawatts as MW, or GW at 1,000 MW and above. */
export function formatPower(mw: number): string {
  if (mw >= 1000) {
    return `${(mw / 1000).toFixed(1)} GW`;
  }
  return `${Math.round(mw)} MW`;
}

/** Formats a million-gallons-per-day water figure. */
export function formatMgd(mgd: number): string {
  return `${mgd.toFixed(1)} MGD`;
}
