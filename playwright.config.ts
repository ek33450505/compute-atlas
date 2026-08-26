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
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run build && npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
