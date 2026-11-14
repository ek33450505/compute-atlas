// Shared name guard for TCEQ-sourced site names (the permit lane and the known-sites CLI).
// A best-effort heuristic on top of the structural rule (a name is printed only under that
// rule): it errs toward withholding, so "BUILDING 100 DATA CENTER" is withheld. A name it
// misses is printed only in an admin-only lead note.

/** NFKC (folds fullwidth digits and letters) plus whitespace collapse. */
export function normalizeName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim();
}

const STREET_WORD_RE =
  /\b(?:circle|cir|lane|ln|drive|dr|street|st|road|rd|avenue|ave|court|ct|way|trail|blvd|boulevard|pkwy|parkway|suite|ste|ter|terrace|cove|pl|place|apt|apartment|unit|lot|dba|residence|home|homes|house|mile|box|pobox)\b/i;

/** A route designator followed by a number: FM 1234, F.M. 12, farm to market 12, HWY 79, IH-35. */
const ROUTE_RE =
  /\b(?:f\.?m\.?|farm[\s-]+to[\s-]+market|rm|ih|sh|us|cr|sr|hwy|highway|interstate|loop|spur)[\s.#-]*\d/i;

/** True when the (normalized) name reads like a street address, a route or a residence. */
export function looksLikeAddress(name: string): boolean {
  const n = normalizeName(name);
  return /^\d/.test(n) || /\d{3,}/.test(n) || ROUTE_RE.test(n) || STREET_WORD_RE.test(n);
}
