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
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
