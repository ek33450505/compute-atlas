/**
 * Maps 2-letter US state codes to full names and URL-friendly slugs.
 * Facilities store `location.state` as an uppercase 2-letter code (e.g. "NY").
 * Includes all 50 states plus the District of Columbia (DC) — a valid facility
 * jurisdiction in the dataset (e.g. CoreSite DC1).
 */

/** State code (uppercase) -> full state name. */
export const US_STATE_NAMES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DC: "District of Columbia",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

/** Converts a full state name to its URL slug (e.g. "New York" -> "new-york"). */
function slugify(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

/** Precomputed slug -> code map, built once at module scope for O(1) reverse lookup. */
const SLUG_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(US_STATE_NAMES).map(([code, name]) => [slugify(name), code])
);

/** Returns the full state name for a 2-letter code (case-insensitive), or undefined if unknown. */
export function stateNameFromCode(code: string): string | undefined {
  return US_STATE_NAMES[code.toUpperCase()];
}

/** Returns the URL slug for a 2-letter code (case-insensitive), or undefined if unknown. */
export function stateSlugFromCode(code: string): string | undefined {
  const name = stateNameFromCode(code);
  return name === undefined ? undefined : slugify(name);
}

/** Returns the 2-letter code for a URL slug (case-insensitive), or undefined if unknown. */
export function stateCodeFromSlug(slug: string): string | undefined {
  return SLUG_TO_CODE[slug.toLowerCase()];
}

/** The District of Columbia's `location.state` code. It is a jurisdiction, not a state. */
export const DC_CODE = "DC";

/** True when a set of `location.state` codes contains DC. */
export function containsDc(codes: Iterable<string>): boolean {
  for (const code of codes) {
    if (code === DC_CODE) {
      return true;
    }
  }
  return false;
}

/**
 * Value+label pair for a stat tile whose underlying count is a number of
 * distinct `location.state` codes. Returned TOGETHER, deliberately: an
 * earlier change made the label DC-aware ("States + DC") but left the VALUE
 * as the raw jurisdiction total, so tiles rendered "51 / States + DC" — read
 * as "fifty-one states, plus DC," live on prod until 2026-09-13. Coupling
 * value and label in one function makes that drift structurally impossible:
 * there is no longer a label-only helper a call site can pair with the raw
 * total by mistake. (There used to be a separate `statesStatLabel` — this
 * replaced it outright, since every one of its call sites was the exact
 * buggy pattern above; keeping both would let them disagree again.)
 *
 * `total` is the raw count of distinct codes, DC included — exactly what
 * every call site already computes (`containsDc(codes)` + `codes.length` /
 * `.size`). When DC is present, the returned `value` is `total - 1`, the
 * actual number of states, never `total`.
 *
 * When `total === 1 && withDc`, DC is the only jurisdiction present and
 * there are zero states to name, so the label must not say "States + DC"
 * (that would name an empty category) — it returns `{ value: 1, label: "DC" }`
 * instead, matching `statesPhrase`. Not reachable from site-wide counts
 * today (the dataset has 51 distinct codes), but is reachable via
 * `getOperatorSummary` for an operator whose facilities are all in DC; no
 * such operator exists in `data/facilities.json` as of 2026-09-13 (the two
 * DC records belong to "365 Data Centers", which also has MA, and
 * "CoreSite", which has 10 jurisdictions), so this is latent, not live.
 */
export function statesStat(total: number, withDc: boolean): { value: number; label: string } {
  if (!withDc) {
    return { value: total, label: total === 1 ? "State" : "States" };
  }
  if (total === 1) {
    return { value: 1, label: "DC" };
  }
  const stateCount = total - 1;
  return { value: stateCount, label: stateCount === 1 ? "State + DC" : "States + DC" };
}

/**
 * Prose form of the same count. `total` is the count of distinct codes, DC
 * included, so callers pass the number they already have.
 */
export function statesPhrase(total: number, withDc: boolean): string {
  if (!withDc) {
    return total === 1 ? "1 state" : `${total} states`;
  }
  if (total === 1) {
    // DC is the only jurisdiction present — there are no states to name.
    return "DC";
  }
  const stateCount = total - 1;
  return `${stateCount === 1 ? "1 state" : `${stateCount} states`} and DC`;
}
