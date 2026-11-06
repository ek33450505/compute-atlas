import { describe, expect, it } from "vitest";

import facilities from "@/data/facilities.json";
import { operatorSlug } from "@/lib/operator-slug";
import { danglingDestinations, shadowedSources } from "@/lib/test-fixtures/redirect-guards";
import nextConfig from "./next.config";

// Real-dataset invariants (DATASET=real, npm run test:dataset). The default run
// applies the shadowing guard to next.config's real redirects against the
// fixture ids (next.config.test.ts). This file repeats it against the full
// dataset and adds the dangling-destination guard, which only the full dataset
// can answer: the survivors (e.g. aws-blanchard-caddo-parish-la,
// firstlight-bedford-nh) are absent from the ~68-record fixture.
//
// Shadowing hides a live page (Next applies redirects before routing).
// Dangling sends one 404 to another, the likely failure over time since a
// destination can itself be retired later.

const redirectsUnder = async (prefix: string) => {
  const all = (await nextConfig.redirects?.()) ?? [];
  return all.filter((r) => r.source.startsWith(prefix));
};

describe("retired-facility redirects (real dataset)", () => {
  const liveSlugs = new Set((facilities as { id: string }[]).map((f) => f.id));
  const slugOf = (path: string) => path.replace("/facilities/", "");

  it("never redirects away from a slug that is still a live facility", async () => {
    const redirects = await redirectsUnder("/facilities/");
    expect(redirects.length).toBeGreaterThan(0);
    const shadowed = shadowedSources(redirects.map((r) => slugOf(r.source)), liveSlugs);

    expect(shadowed).toEqual([]);
  });

  it("only redirects to slugs that are live facilities", async () => {
    const redirects = await redirectsUnder("/facilities/");
    expect(redirects.length).toBeGreaterThan(0);
    const dangling = danglingDestinations(redirects.map((r) => slugOf(r.destination)), liveSlugs);

    expect(dangling).toEqual([]);
  });
});

describe("retired-operator redirects (real dataset)", () => {
  const liveOperatorSlugs = new Set(
    (facilities as { operator: string }[]).map((f) => operatorSlug(f.operator))
  );
  const slugOf = (path: string) => path.replace("/operators/", "");

  it("never redirects away from a slug that is still a live operator", async () => {
    const redirects = await redirectsUnder("/operators/");
    expect(redirects.length).toBeGreaterThan(0);
    const shadowed = shadowedSources(redirects.map((r) => slugOf(r.source)), liveOperatorSlugs);

    expect(shadowed).toEqual([]);
  });

  it("only redirects to slugs that are live operators", async () => {
    const redirects = await redirectsUnder("/operators/");
    expect(redirects.length).toBeGreaterThan(0);
    const dangling = danglingDestinations(
      redirects.map((r) => slugOf(r.destination)),
      liveOperatorSlugs,
    );

    expect(dangling).toEqual([]);
  });
});
