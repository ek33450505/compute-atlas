import { describe, it, expect } from "vitest";
import facilitiesRaw from "@/data/facilities.json";

import { isRestrictedSourceUrl } from "./restricted-sources";

interface FacilityWithSources {
  id: string;
  sources: Array<{ url: string }>;
}

/**
 * Dataset-level regression test, sibling to `lib/siting-context.test.ts`'s
 * "data-integrity" pattern: asserts an invariant over `data/facilities.json`
 * itself, not just over the guard function. `lib/restricted-sources.ts` and
 * `scripts/discovery/verify-source.ts` stop NEW restricted citations from
 * being ingested going forward; this test catches an EXISTING one that
 * slipped in before the guard existed (or slipped past it some other way —
 * e.g. a maintainer-curated `db:sync` publish, which never calls
 * `verifySource` at all).
 *
 * ⚠️ Expected to FAIL as of 2026-09-14: two records
 * (`aws-portage-in`, `takanock-goshen-elkhart-county-in`) still cite
 * interconnection.fyi. That is a known, separately-tracked data cleanup, not
 * a bug in this test — do not weaken this assertion, skip it, or edit the
 * data here to make it pass. See CLAUDE.md's robots-allow-is-not-a-licence
 * note (2026-09-14) for the full rationale.
 */
describe("data-integrity: no restricted-domain source URLs in the dataset", () => {
  it("has no facility whose sources[] cites a restricted domain", () => {
    const facilities = facilitiesRaw as FacilityWithSources[];

    const offenses = facilities.flatMap((facility) =>
      (facility.sources ?? [])
        .filter((source) => isRestrictedSourceUrl(source.url))
        .map((source) => `${facility.id}: ${source.url}`),
    );

    if (offenses.length > 0) {
      const shown = offenses.slice(0, 20);
      const more = offenses.length - shown.length;
      const suffix = more > 0 ? `, and ${more} more` : "";
      throw new Error(
        `${offenses.length} source URL(s) in data/facilities.json cite a ` +
          `licence-restricted domain (see lib/restricted-sources.ts): ` +
          `${shown.join("; ")}${suffix}. ` +
          "Restricted-domain terms forbid redistribution, and our own output " +
          "is CC-BY-4.0 — these facts must be re-sourced to a directly " +
          "citable origin (e.g. the ISO/RTO's own published interconnection " +
          "queue) rather than the aggregator, then republished via " +
          "`npm run db:sync -- --apply` and `npm run db:export`.",
      );
    }

    expect(offenses).toEqual([]);
  });
});
