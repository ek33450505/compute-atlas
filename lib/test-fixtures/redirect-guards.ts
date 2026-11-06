// Shared by next.config.test.ts (default run, against the fixture) and
// next.config.dataset.test.ts (DATASET=real, against the full dataset), so the
// two runs apply the same filters and cannot drift apart.

/** Redirect sources that are still live slugs: each would shadow a live page. */
export const shadowedSources = (sources: string[], live: Set<string>): string[] =>
  sources.filter((slug) => live.has(slug));

/** Redirect destinations that are not live slugs: each sends one 404 to another. */
export const danglingDestinations = (destinations: string[], live: Set<string>): string[] =>
  destinations.filter((slug) => !live.has(slug));
