import { test, expect, type Page } from "@playwright/test";

/**
 * Evidence harness for GitHub issue #236 — mechanical proof of "clean
 * browser consoles" for `next.config.ts`'s report-only CSP.
 *
 * The documented flip criterion (see the long comment above
 * `CSP_REPORT_ONLY_DIRECTIVES` in next.config.ts) is "a week of clean
 * browser consoles" across `/`, `/map` (including satellite mode + the
 * location-search geocoder), `/facilities/*`, and `/admin/login`. There is
 * deliberately no `report-to`/`report-uri` endpoint, so that criterion was
 * previously unfalsifiable: a silent console for a page nobody opened looks
 * identical to a genuinely clean one. This spec replaces "did anyone
 * notice" with a mechanical assertion.
 *
 * This spec does NOT flip the CSP to enforcing and does NOT touch
 * next.config.ts — it only observes the report-only policy already live.
 *
 * Runs against `playwright.config.ts`'s webServer, which is
 * `npm run build && npm run start` — a real production build, not `next
 * dev`. That matters here specifically: `next.config.ts`'s CSP comment notes
 * `https://va.vercel-scripts.com` is allowed in script-src ONLY because
 * Vercel Analytics loads it in development; in production those calls
 * resolve same-origin. A dev-mode run of this spec would not be evidence
 * that transfers to prod. (Confirmed by reading playwright.config.ts, not
 * assumed — see the report for this task.)
 */

const KNOWN_SLUG = "meta-prineville-or";

interface CspViolation {
  violatedDirective: string;
  blockedURI: string;
  documentURI: string;
  /** Where the offending code lives. Absent on console-derived records and on
   * some violation kinds, but for `blockedURI: "eval"` this is the only thing
   * that identifies WHICH bundle called it — without it a failure says only
   * "something on this page evals", which is not actionable. */
  sourceFile?: string;
  lineNumber?: number;
}

/**
 * Captures CSP violations two independent ways, because neither alone is
 * reliable:
 *
 *  - `securitypolicyviolation` DOM events, via an init script registered
 *    with `page.addInitScript` — NOT a plain `page.evaluate` listener added
 *    after load, which would miss violations fired by scripts/resources
 *    that load during the initial page load, before a post-load listener
 *    attach could run. `addInitScript` runs before any page script on every
 *    navigation in this page, including client-side ones.
 *  - Console messages, via `page.on("console", ...)`, matched by text —
 *    Chromium logs a `[Report Only] Refused to ...` line for report-only
 *    CSP violations independently of the DOM event, and either surface can
 *    catch a violation the other one misses depending on timing/resource
 *    type.
 *
 * Returns a getter so callers can read accumulated violations at any point
 * without re-attaching listeners.
 */
function watchCspViolations(page: Page): { get: () => Promise<CspViolation[]> } {
  const consoleViolations: CspViolation[] = [];

  page.on("console", (msg) => {
    const text = msg.text();
    if (/content security policy/i.test(text) && /refused/i.test(text)) {
      consoleViolations.push({
        violatedDirective: text,
        blockedURI: text,
        documentURI: page.url(),
      });
    }
  });

  return {
    async get(): Promise<CspViolation[]> {
      const domViolations = (await page.evaluate(
        () => (window as unknown as { __cspViolations?: CspViolation[] }).__cspViolations ?? []
      )) as CspViolation[];
      return [...domViolations, ...consoleViolations];
    },
  };
}

/** Registers the DOM-event listener before any page script runs. */
async function installCspListener(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: CspViolation[] };
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__cspViolations.push({
        violatedDirective: e.violatedDirective,
        blockedURI: e.blockedURI,
        documentURI: e.documentURI,
        sourceFile: e.sourceFile,
        lineNumber: e.lineNumber,
      });
    });
  });
}

function formatViolations(violations: CspViolation[], route: string): string {
  return `${route}: expected 0 CSP violations, found ${violations.length}:\n${violations
    .map(
      (v) =>
        `  - directive="${v.violatedDirective}" blockedURI="${v.blockedURI}"` +
        (v.sourceFile ? ` at ${v.sourceFile}:${v.lineNumber ?? "?"}` : "")
    )
    .join("\n")}`;
}

// ---------------------------------------------------------------------------
// Harness self-check: prove the listener actually sees a violation before
// trusting any "zero violations" result below. The CSP is report-only, so a
// violation never blocks anything and a naive test passes trivially whether
// or not the listener works at all — this is the check that closes that gap.
// ---------------------------------------------------------------------------

test("harness sanity: a deliberately disallowed resource IS detected", async ({ page }) => {
  await installCspListener(page);
  const watcher = watchCspViolations(page);

  await page.goto("/");

  // img-src has no allowance for example.com — this must violate.
  await page.evaluate(() => {
    const img = document.createElement("img");
    img.src = "https://example.com/csp-harness-canary.png";
    document.body.appendChild(img);
  });

  await expect
    .poll(async () => (await watcher.get()).length, {
      message: "expected the deliberate violation to be reported",
      timeout: 5_000,
    })
    .toBeGreaterThan(0);

  const violations = await watcher.get();
  // Match the host exactly rather than with a substring: `blockedURI` is
  // attacker-shaped in the general case (any origin can appear in it), and a
  // substring test would also accept e.g. "https://example.com.evil.test/".
  // Not a security control here — it is a test assertion — but the loose form
  // is the same shape CodeQL flags as js/incomplete-url-substring-sanitization,
  // and being exact costs nothing. `blockedURI` is not always a URL ("eval",
  // "inline"), hence the try/catch.
  const found = violations.some((v) => {
    try {
      return new URL(v.blockedURI).hostname === "example.com";
    } catch {
      return false;
    }
  });
  expect(found, `expected a violation naming example.com, got: ${JSON.stringify(violations)}`).toBe(
    true
  );
});

// ---------------------------------------------------------------------------
// Real routes — the four families named in next.config.ts's flip criterion.
// ---------------------------------------------------------------------------

test("/ — zero CSP violations", async ({ page }) => {
  await installCspListener(page);
  const watcher = watchCspViolations(page);

  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const violations = await watcher.get();
  expect(violations, formatViolations(violations, "/")).toHaveLength(0);
});

test(`/facilities/${KNOWN_SLUG} — zero CSP violations`, async ({ page }) => {
  await installCspListener(page);
  const watcher = watchCspViolations(page);

  await page.goto(`/facilities/${KNOWN_SLUG}`);
  await page.waitForLoadState("networkidle");

  const violations = await watcher.get();
  expect(
    violations,
    formatViolations(violations, `/facilities/${KNOWN_SLUG}`)
  ).toHaveLength(0);
});

test("/admin/login — zero CSP violations", async ({ page }) => {
  await installCspListener(page);
  const watcher = watchCspViolations(page);

  await page.goto("/admin/login");
  await page.waitForLoadState("networkidle");

  const violations = await watcher.get();
  expect(violations, formatViolations(violations, "/admin/login")).toHaveLength(0);
});

test("/map — zero CSP violations, including satellite mode and the location-search geocoder", async ({
  page,
}) => {
  // Heavy route: MapLibre style/tile load, a satellite-mode toggle that loads
  // a whole new raster tile set, and a geocoder round-trip. Generous,
  // explicit waits throughout rather than fixed sleeps, per the /table
  // axe-timeout lesson (e2e/a11y.spec.ts) — a flaky CSP check would be worse
  // than none, since it would train people to ignore it.
  test.slow();

  // Nominatim's usage policy caps automated callers at ~1 req/sec and
  // disallows heavy scripted use; a CI e2e suite hitting the real endpoint
  // on every run is exactly the pattern that policy exists to stop. CSP
  // evaluation happens in the browser BEFORE the request reaches the
  // network stack — matched purely against the request's target URL — so
  // routing the actual response locally does not change what the CSP
  // engine sees or evaluates. This still genuinely exercises the app's real
  // `fetch("https://nominatim.openstreetmap.org/...")` call site
  // (lib/geocode.ts); only the network fulfillment is local.
  await page.route("https://nominatim.openstreetmap.org/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          lat: "44.3009",
          lon: "-121.2634",
          display_name: "Prineville, Crook County, Oregon, USA",
          boundingbox: ["44.28", "44.32", "-121.29", "-121.24"],
        },
      ]),
    });
  });

  await installCspListener(page);
  const watcher = watchCspViolations(page);

  await page.goto("/map");
  await page.waitForSelector(".maplibregl-canvas-container", { state: "attached" });
  await page.waitForTimeout(1000); // let the base style/vector tiles finish loading

  // --- Gesture 1: satellite mode (services.arcgisonline.com raster tiles) ---
  // The Tools disclosure defaults OPEN on wide+tall viewports (see the
  // WIDE_AND_TALL_VIEWPORT_QUERY lazy initializer in facility-map.tsx) and
  // collapsed everywhere else, so don't assume either starting state — match
  // both labels and only click if it's currently collapsed.
  const toolsToggle = page.getByRole("button", { name: /map tools$/i });
  if ((await toolsToggle.getAttribute("aria-expanded")) === "false") {
    await toolsToggle.click();
  }
  await page.getByRole("button", { name: "Toggle satellite imagery" }).click();
  await expect(page.getByRole("button", { name: "Toggle satellite imagery" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  // Let the satellite raster tile requests actually fire and resolve.
  await page.waitForTimeout(2000);

  // --- Gesture 2: location-search geocoder (nominatim.openstreetmap.org) ---
  const searchInput = page.getByLabel("Go to city or ZIP");
  await searchInput.fill("Prineville, OR");
  await page.getByRole("button", { name: "Search location" }).click();
  // Single mocked result flies immediately (LocationSearch onSelect path).
  // A fixed wait, deliberately: what we are watching for is a CSP violation,
  // which is the ABSENCE of an event, so there is no element state to poll
  // that would tell us none is still coming. The window just has to be wide
  // enough for the geocoder fetch and the resulting flyTo to have run; the
  // test is marked slow, so the cost is bounded.
  await page.waitForTimeout(1500);

  const violations = await watcher.get();
  expect(violations, formatViolations(violations, "/map")).toHaveLength(0);
});
