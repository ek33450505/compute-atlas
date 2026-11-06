/**
 * Minimum-capacity choices offered by the filter bar's capacity popover.
 * Shared with `GET /api/map/match`, which accepts exactly the non-zero values
 * here (as their canonical strings) and nothing else.
 */
export const CAPACITY_OPTIONS = [
  { value: "0", label: "Any" },
  { value: "100", label: "≥100 MW" },
  { value: "500", label: "≥500 MW" },
  { value: "1000", label: "≥1,000 MW" },
] as const;

/** Canonical strings of the options that actually constrain (everything but "Any"). */
export const MATCHABLE_MIN_MW: readonly string[] = CAPACITY_OPTIONS.filter(
  (o) => o.value !== "0"
).map((o) => o.value);
