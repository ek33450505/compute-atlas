import { describe, expect, it } from "vitest";

import facilities from "@/data/facilities.json";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
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

/**
 * Guards the report-only CSP in `next.config.ts`.
 *
 * Deliberately does NOT snapshot the full header value — that would make
 * the test fail on every legitimate new map-tile host added later. Instead
 * it checks presence plus a small, meaningful sample of directives: that
 * defaults are locked down, plugins are disabled, and the policy names real
 * evidenced origins rather than a wildcard.
 */
describe("Content-Security-Policy-Report-Only header", () => {
  const siteWideCsp = async () => {
    const all = (await nextConfig.headers?.()) ?? [];
    const siteWide = all.find((rule) => rule.source === "/:path*");
    return siteWide?.headers.find(
      (h) => h.key === "Content-Security-Policy-Report-Only"
    );
  };

  it("is present on the site-wide header rule", async () => {
    expect(await siteWideCsp()).toBeDefined();
  });

  it("locks down defaults and disables plugins", async () => {
    const csp = await siteWideCsp();
    expect(csp?.value).toContain("default-src 'self'");
    expect(csp?.value).toContain("object-src 'none'");
  });

  it("allowlists the map's real external origins, not a wildcard", async () => {
    const csp = await siteWideCsp();
    expect(csp?.value).toContain("nominatim.openstreetmap.org");
    expect(csp?.value).not.toContain("*");
  });
});

/**
 * Guards the static-asset `Cache-Control` rules (`/data`, `/basemap`) against
 * shadowing a real app route.
 *
 * `getPathMatch` is Next's OWN compiled route matcher
 * (`next/dist/shared/lib/router/utils/path-match`, the same function
 * `headers()`/`redirects()`/`rewrites()` sources are compiled with) — not the
 * top-level `path-to-regexp` package, whose v8 syntax is incompatible and
 * throws on `:path*`/`:path+` entirely. Using anything else risks asserting
 * on behaviour Next.js doesn't actually implement.
 *
 * The real failure mode: `:path*` matches zero-or-more segments, so
 * `/data/:path*` also matches the bare `/data` route — a real page
 * (`app/data/page.tsx`), not just a prefix for files under `public/data/`.
 * That shadowed the page with an 86400s edge cache and a 604800s
 * stale-while-revalidate tail (shipped to prod, caught 2026-09-05: the page
 * served a stale record count for a full day). `:path+` requires at least
 * one segment, which excludes the bare route while still matching real
 * asset paths.
 */
describe("asset-cache headers don't shadow app routes", () => {
  const assetCacheRules = async () => {
    const all = (await nextConfig.headers?.()) ?? [];
    // Identify the asset rules by their distinctive day-long edge TTL rather
    // than by hardcoding "/data/:path+" — that would pass even if the fix
    // were reverted to ":path*", since the string itself never changes.
    return all.filter((rule) =>
      rule.headers.some(
        (h) => h.key === "Cache-Control" && h.value.includes("s-maxage=86400")
      )
    );
  };

  it("does not apply the day-long asset cache to the bare /data route", async () => {
    for (const rule of await assetCacheRules()) {
      const matches = getPathMatch(rule.source);
      expect(matches("/data"), `${rule.source} should not match bare /data`).toBe(
        false
      );
    }
  });

  it("still applies the asset cache to real files under /data", async () => {
    const rules = await assetCacheRules();
    const dataRule = rules.find((r) => r.source.startsWith("/data/"));
    expect(dataRule, "expected a /data asset-cache rule to exist").toBeDefined();

    const matches = getPathMatch(dataRule!.source);
    expect(matches("/data/water.geojson")).not.toBe(false);
  });

  it("does not apply an asset-cache header to other real app routes", async () => {
    const rules = await assetCacheRules();
    for (const path of ["/", "/stats"]) {
      for (const rule of rules) {
        const matches = getPathMatch(rule.source);
        expect(matches(path), `${rule.source} should not match ${path}`).toBe(
          false
        );
      }
    }
  });
});
