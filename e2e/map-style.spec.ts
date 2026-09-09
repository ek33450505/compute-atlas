import { expect, test, type Page } from "@playwright/test";

/**
 * Regression gate for the MapLibre worker asset.
 *
 * The basemap once shipped completely blank on `/` and `/map`: the bundler-emitted
 * worker module carried an unrewritten relative import of its `maplibre-gl-shared.mjs`
 * sibling, so the worker 404'd and never booted, and the style never finished loading.
 * Every existing test still passed, because they only assert that a canvas element
 * exists — a canvas is created before the style loads and stays there when the style
 * never arrives. This file asserts the thing that actually matters: `isStyleLoaded()`
 * becomes true, and nothing under `/maplibre/` 404s while the page loads.
 */

const ROUTES = [
  { path: "/", label: "home hero globe" },
  { path: "/map", label: "map page" },
] as const;

type MapProbe = { error: string } | { loaded: boolean; styleLoaded: boolean };

/**
 * The app exposes no global handle on the MapLibre instance, so we walk the React
 * fiber up from the map container looking for an object that quacks like `Map`.
 */
async function probeMapStyle(page: Page): Promise<MapProbe> {
  return page.evaluate(() => {
    const el =
      document.querySelector(".maplibregl-map") ??
      document.querySelector(".maplibregl-canvas-container");
    if (!el) return { error: "no map container" };

    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    if (!key) return { error: "no react fiber key" };

    // Reallocated per fiber in the walk below: a node first visited at the depth
    // cutoff would otherwise stay "seen" for every later fiber, which can hide a
    // map the walk would have found from a shallower start.
    let seen = new Set<unknown>();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const isMap = (o: any) =>
      o &&
      typeof o === "object" &&
      typeof o.isStyleLoaded === "function" &&
      typeof o.dragPan === "object";

    const scan = (o: any, d: number): any => {
      if (!o || d > 6 || typeof o !== "object" || seen.has(o)) return null;
      seen.add(o);
      if (isMap(o)) return o;
      for (const k of [
        "current",
        "_map",
        "map",
        "stateNode",
        "memoizedState",
        "memoizedProps",
        "baseState",
        "next",
      ]) {
        const r = scan(o[k], d + 1);
        if (r) return r;
      }
      return null;
    };

    let fiber: any = (el as any)[key];
    for (let i = 0; i < 40 && fiber; i++, fiber = fiber.return) {
      seen = new Set<unknown>();
      const m = scan(fiber, 0);
      if (m) return { loaded: m.loaded(), styleLoaded: m.isStyleLoaded() };
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
    return { error: "map instance not found in fiber walk" };
  });
}

for (const route of ROUTES) {
  test(`${route.label} (${route.path}): MapLibre style finishes loading`, async ({ page }) => {
    // The style pulls tiles, sprites and glyphs from tiles.openfreemap.org, so
    // the default 30s per-test budget is too tight. test.slow() triples it (90s),
    // matching the existing pattern in a11y.spec.ts / csp.spec.ts.
    test.slow();

    const workerFailures: string[] = [];
    page.on("response", (response) => {
      const url = response.url();
      if (/maplibre/i.test(url) && response.status() >= 400) {
        workerFailures.push(`${response.status()} ${url}`);
      }
    });

    await page.goto(route.path);

    // The map container mounts lazily (dynamic import), so wait for it before probing.
    await page.waitForSelector(".maplibregl-map, .maplibregl-canvas-container", {
      timeout: 30_000,
    });

    try {
      // Remote tiles + sprites come from tiles.openfreemap.org, so give this room.
      await expect
        .poll(
          async () => {
            const probe = await probeMapStyle(page);
            // Surface the fiber-walk failure verbatim instead of silently polling
            // forever — a walk that stops finding the map would make this gate vacuous.
            if ("error" in probe) return `fiber-walk error: ${probe.error}`;
            return probe.styleLoaded;
          },
          {
            timeout: 60_000,
            intervals: [500, 1_000, 2_000],
            message: `MapLibre style never finished loading on ${route.path}`,
          }
        )
        .toBe(true);
    } finally {
      // Checked in `finally` on purpose. A failing 4xx on a maplibre asset is the
      // direct signature of this bug and the more actionable diagnosis, but the
      // style poll above times out first — so asserting it only on the happy path
      // would mean it never runs in exactly the run that needed it.
      expect(
        workerFailures,
        `4xx/5xx responses for maplibre assets on ${route.path}`
      ).toEqual([]);
    }
  });
}
