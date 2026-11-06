/**
 * The `@/data/*.json` files vitest.config.ts redirects to tests/fixtures/. A
 * data import outside this list reads real data in the default run;
 * fixtures.test.ts fails if one appears.
 */
export const ALIASED_DATA_FILES = [
  "facilities.json",
  "facilities.meta.json",
  "siting-context.json",
  "operator-ownership.json",
] as const;
