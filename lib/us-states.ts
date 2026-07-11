/**
 * Maps 2-letter US state codes to full names and URL-friendly slugs.
 * Facilities store `location.state` as an uppercase 2-letter code (e.g. "NY").
 * Includes all 50 states (no District of Columbia).
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
