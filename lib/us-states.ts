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
 * Label for a stat tile whose VALUE is a count of distinct `location.state`
 * codes. The value stays honest only if the label admits DC is inside it —
 * "51 / States" was live on prod until 2026-09-13.
 *
 * When `total === 1 && withDc`, DC is the only jurisdiction present and there
 * are zero states to name, so the label must not say "States + DC" (that
 * would name an empty category) — it returns "DC" alone, matching
 * `statesPhrase`. Not reachable from site-wide counts today (the dataset has
 * 51 distinct codes), but is reachable via `getOperatorSummary` for an
 * operator whose facilities are all in DC; no such operator exists in
 * `data/facilities.json` as of 2026-09-13 (the two DC records belong to
 * "365 Data Centers", which also has MA, and "CoreSite", which has 10
 * jurisdictions), so this is latent, not live.
 */
export function statesStatLabel(total: number, withDc: boolean): string {
  if (withDc) {
    return total === 1 ? "DC" : "States + DC";
  }
  return total === 1 ? "State" : "States";
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
