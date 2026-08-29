import { test, expect, type Page } from "@playwright/test";

/**
 * Mobile/touch coverage for /map.
 *
 * Scoped (see playwright.config.ts's "Mobile Chrome" project testMatch) to
 * run ONLY this file, and ONLY under touch emulation:
 *  - the pool-poisoning regression below reproduces the same way on any
 *    viewport (it's a maplibre handler-enable bug, not a layout bug), so one
 *    confirmation under touch is sufficient signal; the desktop "chromium"
 *    project's own passing run already covers the non-touch path.
 *  - the touch-drag assertion drives MapLibre over CDP's
 *    Input.dispatchTouchEvent, which is only meaningful under hasTouch: true
 *    and is Chromium-only (no WebKit/iPhone-preset equivalent).
 *
 * Root cause this file pins (fixed in 9ee89d3 — see the long comment on
 * `interactive` in components/facility/facility-mini-map.tsx): react-map-gl's
 * `reuseMaps` pools maplibre-gl Map instances in a module-level array shared
 * by every `<Map reuseMaps>` in the app. FacilityMiniMap used to mount a
 * pooled `interactive={false}` map with no handler props; on reuse by
 * FacilityMap (/map), prop-diffing sees no change for any handler prop
 * neither side sets explicitly and never calls `.enable()` — silently
 * killing drag-pan/pinch-zoom/wheel-zoom/keyboard-pan on /map, but only after
 * an in-page navigation from a page that mounts the mini-map first.
 */

const KNOWN_SLUG = "meta-prineville-or";

/** Reads the maplibre canvas container's touch-handler classes + computed touch-action. */
async function readCanvasTouchState(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector(".maplibregl-canvas-container");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      hasDragPanClass: el.classList.contains("maplibregl-touch-drag-pan"),
      hasZoomRotateClass: el.classList.contains("maplibregl-touch-zoom-rotate"),
      touchAction: cs.touchAction,
    };
  });
}

/**
 * Reads the map's coordinate readout text — the ONLY `role="status"` region
 * on /map whose content contains "°" (formatLatLon in lib/graticule.ts emits
 * e.g. "39.50° N · 98.50° W"). /map mounts THREE role="status" regions: the
 * filter-bar result count ("Showing N of M facilities" —
 * map-filter-subheader.tsx, first in document order), location-search's live
 * status, and this coordinate readout (facility-map.tsx). A bare
 * `getByRole('status')` / `[role="status"]` locator matches the result count
 * first, which never changes on pan — that would make a "did the center
 * move" assertion pass vacuously no matter what. Filtering by "°" content is
 * what makes this discriminating (this exact collision broke a Playwright
 * locator once — commit a2a3081).
 */
async function readMapCentreText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const candidates = [...document.querySelectorAll('[role="status"]')];
    const el = candidates.find((e) => /°/.test(e.textContent ?? ""));
    return el ? (el.textContent ?? "").trim() : null;
  });
}

/** Opens the Tools panel, then turns on the coordinate readout ("lock coordinates"). */
async function enableCoordReadout(page: Page) {
  await page.getByRole("button", { name: "Show map tools" }).click();
  await page.getByRole("button", { name: "Show map coordinates readout" }).click();
}

/**
 * Parses formatLatLon's readout text (lib/graticule.ts:
 * `` `${latStr}° ${latHemi} · ${lonStr}° ${lonHemi}` ``, e.g.
 * "39.50° N · 98.50° W") into signed decimal degrees (S and W negative).
 */
function parseLatLon(text: string): { lat: number; lon: number } {
  const m = text.match(/^(\d+\.\d+)°\s*([NS])\s*·\s*(\d+\.\d+)°\s*([EW])$/);
  if (!m) throw new Error(`unparsable coordinate readout: "${text}"`);
  const [, latStr, latHemi, lonStr, lonHemi] = m;
  return {
    lat: parseFloat(latStr) * (latHemi === "S" ? -1 : 1),
    lon: parseFloat(lonStr) * (lonHemi === "W" ? -1 : 1),
  };
}

/**
 * Polls the coordinate readout until two reads ~200ms apart agree, proving
 * the map is at rest rather than assuming a fixed wait was long enough.
 * `enableCoordReadout`'s second click is what mounts the readout element;
 * the Tools column itself can't resize the map (facility-map.tsx: the panel
 * is `absolute top-20 right-2 z-30`, not part of layout flow) but confirming
 * stillness is cheap and removes the assumption entirely. Gives up after 2s
 * (10 attempts) and returns the last read, so a map that never settles fails
 * the surrounding assertion instead of hanging the test.
 */
async function waitForStableCentre(page: Page): Promise<string> {
  let previous = await readMapCentreText(page);
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.waitForTimeout(200);
    const current = await readMapCentreText(page);
    if (current !== null && current === previous) return current;
    previous = current;
  }
  if (previous === null) throw new Error("coordinate readout never appeared");
  return previous;
}

test.describe("map mobile touch", () => {
  test("in-page navigation to /map keeps touch gestures live (reuseMaps pool-poisoning regression)", async ({
    page,
  }) => {
    // page.goto('/map') directly would be a fresh document load, starting
    // with an EMPTY Maplibre.savedMaps pool — that can't reproduce the bug
    // and would make this test pass vacuously. The regression only
    // reproduces via a genuine in-page (SPA) navigation that mounts
    // FacilityMiniMap's pooled map first, so we must arrive at /map by
    // clicking a real link, not by navigating directly.
    await page.goto(`/facilities/${KNOWN_SLUG}`);
    await page.waitForSelector(".maplibregl-canvas-container", {
      // The canvas *container* has a zero-size bounding box, so Playwright's
      // default `state: 'visible'` wait times out here — wait for attached.
      state: "attached",
    });
    await page.waitForTimeout(1000); // let the mini-map fully mount

    // Mobile viewport: the "Map" link lives inside the hamburger panel
    // (components/mobile-nav.tsx), not the sm:hidden desktop PrimaryNav.
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await page
      .getByRole("navigation", { name: "Mobile navigation" })
      .getByRole("link", { name: "Map", exact: true })
      .click();
    await page.waitForURL("**/map");

    await page.waitForSelector(".maplibregl-canvas-container", {
      state: "attached",
    });
    await page.waitForTimeout(1000); // let onLoad's handler-enable settle

    const state = await readCanvasTouchState(page);
    expect(state).not.toBeNull();
    expect(state?.hasDragPanClass).toBe(true);
    expect(state?.hasZoomRotateClass).toBe(true);
    expect(state?.touchAction).toBe("none");
  });

  test("a real touch drag pans the map", async ({ page }) => {
    await page.goto("/map");
    await page.waitForSelector(".maplibregl-canvas-container", {
      state: "attached",
    });
    await page.waitForTimeout(1000);

    await enableCoordReadout(page);

    const beforeText = await waitForStableCentre(page);
    expect(beforeText).not.toMatch(/Showing/);
    // Pins the assumption the direction assertions below rest on: they're
    // only valid for a drag starting from lib/map.ts's INITIAL_VIEW_STATE
    // (longitude -98.5, latitude 39.5, zoom 3.4). If that default camera
    // legitimately changes, this fails here with an obvious message instead
    // of a cryptic sign mismatch further down.
    expect(beforeText).toBe("39.50° N · 98.50° W");
    const before = parseLatLon(beforeText);

    const box = await page.locator(".maplibregl-canvas").boundingBox();
    if (!box) throw new Error("map canvas has no bounding box");
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;

    // Playwright has no built-in touch-swipe helper, and MapLibre's
    // DragPanHandler needs real deltas over time — a single jump-move is a
    // known false negative — so drive the gesture directly over CDP.
    const cdp = await page.context().newCDPSession(page);
    const STEPS = 10;
    const TOTAL_DX = -120;
    const TOTAL_DY = -80;
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: startX, y: startY }],
    });
    for (let i = 1; i <= STEPS; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x: startX + (TOTAL_DX * i) / STEPS, y: startY + (TOTAL_DY * i) / STEPS },
        ],
      });
      await page.waitForTimeout(30);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    const afterText = await waitForStableCentre(page);
    expect(afterText).not.toMatch(/Showing/);
    const after = parseLatLon(afterText);

    const deltaLat = after.lat - before.lat;
    const deltaLon = after.lon - before.lon;

    // Measured directly (byte-identical across 3 consecutive runs — this
    // gesture is fully deterministic, not just sign-stable) for this exact
    // TOTAL_DX=-120, TOTAL_DY=-80 drag at /map's default zoom (~3.4):
    //   "39.50° N · 98.50° W"  ->  "35.39° N · 90.70° W"
    //   deltaLat -4.11, deltaLon +7.8
    // Do NOT re-derive the expected sign from the drag vector by intuition —
    // it doesn't match a naive "content follows finger" prediction (a
    // separate debugger drag on this same map observed latitude moving the
    // OPPOSITE way for what looked like a comparable gesture). The
    // assertions below encode the actually-measured, run-stable pair, not a
    // predicted one. MIN_DELTA_DEG=1 sits comfortably above jitter/re-render
    // noise (hundredths of a degree) and well under the ~4-8° this gesture
    // actually produces.
    const MIN_DELTA_DEG = 1;
    expect(Math.abs(deltaLat)).toBeGreaterThan(MIN_DELTA_DEG);
    expect(Math.abs(deltaLon)).toBeGreaterThan(MIN_DELTA_DEG);
    expect(deltaLat).toBeLessThan(0); // latitude moves south for this drag
    expect(deltaLon).toBeGreaterThan(0); // longitude moves east for this drag
  });
});
