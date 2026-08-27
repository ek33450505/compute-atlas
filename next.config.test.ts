import { describe, expect, it } from "vitest";

import facilities from "@/data/facilities.json";
import nextConfig from "./next.config";

/**
 * Guards the retired-facility redirect list in `next.config.ts`.
 *
 * Both assertions have a real failure mode, and neither is satisfied by the
 * list simply existing:
 *
 * - A `source` that is a LIVE facility slug would shadow that facility's page,
 *   because Next applies redirects before routing. The facility would silently
 *   become unreachable.
 * - A `destination` that is NOT a live facility slug redirects one 404 to
 *   another, which is worse than the plain 404 it replaced — and this is the
 *   likely failure over time, since a destination can itself be retired later.
 */
describe("retired-facility redirects", () => {
  const liveSlugs = new Set((facilities as { id: string }[]).map((f) => f.id));

  const facilityRedirects = async () => {
    const all = (await nextConfig.redirects?.()) ?? [];
    return all.filter((r) => r.source.startsWith("/facilities/"));
  };

  const slugOf = (path: string) => path.replace("/facilities/", "");

  it("never redirects away from a slug that is still a live facility", async () => {
    const shadowed = (await facilityRedirects())
      .map((r) => slugOf(r.source))
      .filter((slug) => liveSlugs.has(slug));

    expect(shadowed).toEqual([]);
  });

  it("only redirects to slugs that are live facilities", async () => {
    const dangling = (await facilityRedirects())
      .map((r) => slugOf(r.destination))
      .filter((slug) => !liveSlugs.has(slug));

    expect(dangling).toEqual([]);
  });

  it("marks retired-facility redirects permanent so link equity carries over", async () => {
    for (const redirect of await facilityRedirects()) {
      expect(redirect.permanent, `${redirect.source} should be permanent`).toBe(true);
    }
  });
});
