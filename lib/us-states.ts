/**
 * Maps 2-letter US jurisdiction codes to full names and URL-friendly slugs.
 * Facilities store `location.state` as an uppercase 2-letter code (e.g. "NY").
 * Includes all 50 states plus the District of Columbia (DC) — a valid facility
 * jurisdiction in the dataset (e.g. CoreSite DC1) — and, separately, US
 * territories (see `US_TERRITORY_NAMES` below).
 */

/** State code (uppercase) -> full state name. Includes DC. */
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

/**
 * US territory code (uppercase) -> full territory name. `location.state`
 * stores a territory's 2-letter USPS code exactly like it stores a state's —
 * `lib/schema.ts`'s `state: z.string().length(2)` and the Postgres `text`
 * column both already accept these values. Territories are grouped WITH DC
 * as jurisdictions outside the 50 states; see `isStateCode`,
 * `isTerritoryCode`, and `splitJurisdictions` below for the distinction.
 */
export const US_TERRITORY_NAMES: Record<string, string> = {
  AS: "American Samoa",
  GU: "Guam",
  MP: "Northern Mariana Islands",
  PR: "Puerto Rico",
  VI: "U.S. Virgin Islands",
};

/** All jurisdiction names — states, DC, and territories — merged for lookups that must resolve either. */
const ALL_JURISDICTION_NAMES: Record<string, string> = {
  ...US_STATE_NAMES,
  ...US_TERRITORY_NAMES,
};

/**
 * Converts a full jurisdiction name to its URL slug (e.g. "New York" ->
 * "new-york"). Strips punctuation before collapsing separators, not just
 * whitespace — "U.S. Virgin Islands" must slugify to "us-virgin-islands",
 * not "u.s.-virgin-islands": a whitespace-only version of this function let
 * the periods survive into a real, SEO-hostile public URL, undetected
 * because the slug still round-tripped correctly back to "VI". None of the
 * 50 states or "District of Columbia" contain punctuation, so this changes
 * no existing slug — pinned by a literal-map test in us-states.test.ts.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Precomputed slug -> code map (states, DC, and territories), built once at module scope for O(1) reverse lookup. */
const SLUG_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(ALL_JURISDICTION_NAMES).map(([code, name]) => [slugify(name), code])
);

/** Returns the full jurisdiction name (state, DC, or territory) for a 2-letter code (case-insensitive), or undefined if unknown. */
export function stateNameFromCode(code: string): string | undefined {
  return ALL_JURISDICTION_NAMES[code.toUpperCase()];
}

/** Returns the URL slug for a 2-letter jurisdiction code (case-insensitive), or undefined if unknown. */
export function stateSlugFromCode(code: string): string | undefined {
  const name = stateNameFromCode(code);
  return name === undefined ? undefined : slugify(name);
}

/** Returns the 2-letter jurisdiction code for a URL slug (case-insensitive), or undefined if unknown. */
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

/** True when `code` is one of the five US territories (AS, GU, MP, PR, VI). Case-insensitive. */
export function isTerritoryCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(US_TERRITORY_NAMES, code.toUpperCase());
}

/**
 * True when `code` is one of the 50 states — and only the 50 states.
 * DC is a jurisdiction, not a state, so `isStateCode("DC")` is false;
 * use `containsDc` or `splitJurisdictions` for DC-aware handling.
 */
export function isStateCode(code: string): boolean {
  const upper = code.toUpperCase();
  return upper !== DC_CODE && Object.prototype.hasOwnProperty.call(US_STATE_NAMES, upper);
}

/**
 * Splits a set of `location.state` codes into the 50-state codes and
 * everything else (DC plus any territories). Both returned arrays are
 * sorted and de-duplicated. Codes are case-normalized to uppercase; a code
 * that isn't a recognized state, DC, or territory is silently ignored
 * rather than thrown on — a bad code in the data must never crash a page.
 */
export function splitJurisdictions(codes: Iterable<string>): { states: string[]; other: string[] } {
  const states = new Set<string>();
  const other = new Set<string>();
  for (const code of codes) {
    const upper = code.toUpperCase();
    if (isStateCode(upper)) {
      states.add(upper);
    } else if (upper === DC_CODE || isTerritoryCode(upper)) {
      other.add(upper);
    }
  }
  return { states: [...states].sort(), other: [...other].sort() };
}

/**
 * Value + label (+ optional footnote) for a stat tile whose underlying count
 * is a set of distinct `location.state` codes. Returned TOGETHER,
 * deliberately: an earlier change made the label DC-aware ("States + DC") but
 * left the VALUE as the raw jurisdiction total, so tiles rendered
 * "51 / States + DC" — read as "fifty-one states, plus DC," live on prod
 * until 2026-09-13. Coupling value and label in one function makes that drift
 * structurally impossible: there is no longer a label-only helper a call site
 * can pair with the raw total by mistake. (There used to be a separate
 * `statesStatLabel` — this replaced it outright, since every one of its call
 * sites was the exact buggy pattern above; keeping both would let them
 * disagree again.)
 *
 * Territories extend the same reasoning one step further: this takes the
 * CODES themselves — `Iterable<string>` — rather than a pre-computed total,
 * which is what makes a territory miscount structurally impossible too. A
 * caller can no longer hand this a total that silently includes DC,
 * territories, or both; `value` is always the number of actual states,
 * derived here via `splitJurisdictions`, never trusted from the caller.
 *
 * ⚠️ The label is deliberately BARE — "States", never "States + DC +
 * territories". That three-term form was correct and unreadable: stacked
 * under a 4xl figure in uppercase mono with wide tracking, it swamped the
 * number it captioned and unbalanced every row it sat in (Ed, QA,
 * 2026-09-14). What the extra jurisdictions are now rides in `note`, which
 * renders as a footnote under the row behind a `*` marker — the count stays
 * honest, the caption stays one word, and the label can never grow a term no
 * matter how many territories the dataset picks up.
 *
 * `value` is the count of the 50-state codes present. `label` captions it.
 * `note` is present ONLY when non-state jurisdictions accompany at least one
 * state — i.e. exactly when the bare label would otherwise under-report:
 *   - states only                                -> "State" / "States", no note
 *   - states + DC only                           -> + "Plus the District of Columbia"
 *   - states + territories only                  -> + "Plus 1 U.S. territory" / "Plus 3 U.S. territories"
 *   - states + DC + territories                  -> + "Plus the District of Columbia and 4 U.S. territories"
 *   - DC only, no states                         -> "DC", no note
 *   - exactly one territory, no states           -> that territory's name (e.g. "Puerto Rico"), no note
 *   - several non-state jurisdictions, no states -> "Jurisdictions", no note
 *   - empty                                      -> "States", no note
 * The zero-state cases carry no note because their label already names the
 * whole set — a footnote there would repeat the caption, not extend it.
 */
export function statesStat(codes: Iterable<string>): {
  value: number;
  label: string;
  note?: string;
} {
  const { states, other } = splitJurisdictions(codes);
  const stateCount = states.length;

  if (stateCount === 0) {
    if (other.length === 0) {
      return { value: 0, label: "States" };
    }
    if (other.length === 1) {
      const code = other[0];
      // Fallback, not `!`: `splitJurisdictions` only ever admits DC_CODE or a
      // known territory into `other`, so `stateNameFromCode(code)` cannot be
      // undefined today — but this file's whole purpose is not trusting an
      // invariant a future edit could quietly relax (that was exactly how
      // six call sites shipped `undefined` links to `/states/undefined`). A
      // bare code rendering is a degraded label; `undefined` is the bug.
      return { value: 1, label: code === DC_CODE ? "DC" : (stateNameFromCode(code) ?? code) };
    }
    return { value: other.length, label: "Jurisdictions" };
  }

  const label = stateCount === 1 ? "State" : "States";
  const note = jurisdictionNote(other);
  return note ? { value: stateCount, label, note } : { value: stateCount, label };
}

/**
 * Footnote text for the non-state jurisdictions sitting alongside a state
 * count — DC, territories, or both. Returns `undefined` when there are none,
 * so `statesStat` can omit the key entirely rather than emit an empty note a
 * render primitive would have to special-case.
 *
 * Unlike the tile label, this is prose and may carry a count: a footnote has
 * a whole line to itself, so "4 U.S. territories" costs nothing here while
 * the same precision in the caption is what made the caption unreadable.
 * Territories are still never listed by name — that would grow without
 * bound; the reader who wants the names has /states.
 *
 * `other` is `splitJurisdictions().other` — sorted, de-duplicated, and
 * containing only DC or recognized territory codes.
 */
function jurisdictionNote(other: readonly string[]): string | undefined {
  const hasDc = other.includes(DC_CODE);
  const territoryCount = other.length - (hasDc ? 1 : 0);

  if (!hasDc && territoryCount === 0) return undefined;

  const territoryPhrase =
    territoryCount === 1 ? "1 U.S. territory" : `${territoryCount} U.S. territories`;

  if (hasDc && territoryCount === 0) return "Plus the District of Columbia";
  if (!hasDc) return `Plus ${territoryPhrase}`;
  return `Plus the District of Columbia and ${territoryPhrase}`;
}

/**
 * Prose form of the same count as `statesStat`, taking the same
 * `Iterable<string>` of `location.state` codes for the same reason: a
 * caller can no longer hand this a total that silently includes DC or
 * territories. The previous body did `total - 1`, assuming DC was the only
 * possible non-state member of the set — with a territory present that
 * produced e.g. "52 states and DC", the prose form of the exact bug fixed
 * in `statesStat` (PR #304).
 *
 * Closely related to `statesStat`'s `note`, and deliberately not unified
 * with it. Both are prose and both carry a territory count, but they answer
 * different questions: `note` extends a caption whose figure is already on
 * screen ("Plus the District of Columbia and 4 U.S. territories"), while this
 * is a self-contained clause that must name the state count too ("50 states,
 * DC and 4 territories"). Merging them would force one of the two to say
 * something it does not mean. Neither is the TILE LABEL, which stays one word
 * — see the note on `statesStat` for why.
 *
 *   - 1 state, nothing else                      -> "1 state"
 *   - N states, nothing else                      -> "N states"
 *   - N states + DC only                           -> "N states and DC" (byte-identical to the prior wording)
 *   - N states + territories only                  -> "N states and 1 territory" / "N states and 2 territories"
 *   - N states + DC + territories                  -> "N states, DC and 2 territories"
 *   - DC only, no states                           -> "DC"
 *   - exactly one territory, no states             -> that territory's name (e.g. "Puerto Rico")
 *   - several non-state jurisdictions, no states   -> "3 jurisdictions"
 *   - empty                                        -> "0 states"
 */
export function statesPhrase(codes: Iterable<string>): string {
  const { states, other } = splitJurisdictions(codes);
  const stateCount = states.length;

  if (stateCount === 0) {
    if (other.length === 0) {
      return "0 states";
    }
    if (other.length === 1) {
      const code = other[0];
      // DC is the only jurisdiction present — there are no states to name.
      // Fallback, not `!`, for the same reason as in `statesStat` above.
      return code === DC_CODE ? "DC" : (stateNameFromCode(code) ?? code);
    }
    return `${other.length} jurisdictions`;
  }

  const stateCountPhrase = stateCount === 1 ? "1 state" : `${stateCount} states`;
  const hasDc = other.includes(DC_CODE);
  const territoryCount = other.length - (hasDc ? 1 : 0);

  if (!hasDc && territoryCount === 0) {
    return stateCountPhrase;
  }
  if (hasDc && territoryCount === 0) {
    return `${stateCountPhrase} and DC`;
  }
  const territoryCountPhrase = territoryCount === 1 ? "1 territory" : `${territoryCount} territories`;
  if (!hasDc && territoryCount > 0) {
    return `${stateCountPhrase} and ${territoryCountPhrase}`;
  }
  return `${stateCountPhrase}, DC and ${territoryCountPhrase}`;
}
