import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "html",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    // Force the reduced-motion accessible path for every test. Without this,
    // axe scans `/` mid-way through the scroll-driven `.plate-reveal` entrance
    // animation (app/globals.css, `animation-timeline: view()`): below-fold
    // elements sit mid-fade, axe measures the RENDERED (blended) color against
    // parchment, and reports a false color-contrast violation even though the
    // token pair is AA-clear at rest. The animation is itself
    // `@media (prefers-reduced-motion: no-preference)`-gated, so this setting
    // exercises the same code path reduced-motion users already get — it is
    // not disabling coverage, it's removing a false negative.
    // (`reducedMotion` lives under `contextOptions` in this Playwright
    // version's `use` type, not flattened at the top level.)
    contextOptions: {
      reducedMotion: "reduce",
    },
  },
  projects: [
    {
      name: "chromium",
      // The mobile-only touch spec runs exclusively under "Mobile Chrome"
      // below — excluded here so it doesn't ALSO run (redundantly, and
      // against a non-touch context where its CDP touch-dispatch assertions
      // don't mean anything) on desktop.
      testIgnore: /map-mobile\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "Mobile Chrome",
      // Scoped to ONLY e2e/map-mobile.spec.ts — intentionally not the full
      // suite. Running every existing desktop-authored spec a second time
      // under mobile emulation would roughly double CI runtime for no new
      // signal (most assertions don't depend on touch/viewport) and would
      // likely surface unrelated layout failures that belong to a dedicated
      // responsive-layout audit, not this regression-cover unit.
      // devices["Pixel 5"], not an iPhone preset: it's Chromium-backed with
      // realistic hasTouch/isMobile/DPR, and the touch-drag assertion drives
      // MapLibre via CDP's Input.dispatchTouchEvent, which only exists for
      // Chromium — a WebKit (iPhone) preset can't run it at all.
      testMatch: /map-mobile\.spec\.ts$/,
      use: { ...devices["Pixel 5"] },
    },
  ],
  webServer: {
    command: "npm run build && npm run start",
    url: "http://localhost:3000",
    // Deliberately NOT reusing an existing server. On 2026-09-07 a stale
    // next-server left running from an earlier session served ~2-day-old
    // build output to every local run, so e2e/csp.spec.ts reported 5/5 green
    // for a fix that CI (which always builds fresh) correctly failed. A
    // suite whose job is to produce evidence must not silently test a build
    // nobody asked for. The cost is a rebuild per local run; that is the
    // right trade for a check that is only worth anything if it is trusted.
    reuseExistingServer: false,
    // Sized for a COLD CI runner, not this laptop. The build prerenders
    // 3,039 routes (facilities 1,571 · operators 645 · counties 637 ·
    // states 51 · embed 50 · metros 28) — the by-county lens added 637 of
    // them, +26.5% over the previous 2,402. Measured locally 2026-09-11 on
    // an M-series Mac: 114.3s cold (after clearing .next/cache), 53.1s warm.
    // ci.yml's e2e job caches no .next, so CI is ALWAYS the cold path, on
    // slower shared hardware — and a 240s budget put a passing build inside
    // ~2x of the ceiling. That is not enough margin for a check that blocks
    // every merge to main: a webServer timeout there is indistinguishable
    // from a real failure and gets retried rather than diagnosed (it was
    // observed once locally on 2026-09-11 and did not reproduce).
    //
    // The trade, stated honestly: a genuinely hung build now burns 10
    // minutes before failing instead of 4. That is the right price — a slow
    // true failure costs one job, a false timeout blocks the branch. Raise
    // the ROUTE COUNT's cost (fewer prerendered pages) before raising this
    // again; per ci.yml, this value is the remedy, not "fixing" the tests.
    timeout: 600_000,
  },
});
