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

/**
 * Second self-check, added when the policy went ENFORCING (issue #236): the
 * `report-uri` channel actually delivers.
 *
 * This is the same class of gap the sanity test above closes. A report
 * endpoint that no browser ever posts to produces zero reports — which is
 * indistinguishable from a site with zero violations, and would leave the
 * one thing that makes enforcement observable quietly broken. Nothing in the
 * unit tests can catch that: they call the route handler directly and so
 * prove only that it parses what it is given, never that a browser aims a
 * real report at it.
 *
 * Listening on the CONTEXT rather than the page: a violation report is
 * emitted by the browser's own reporting machinery, not by page script, so
 * it is not reliably attributed to the originating frame.
 */
test("report-uri delivers a real violation to the report endpoint", async ({ page }) => {
  const reportPosted = page
    .context()
    .waitForEvent("request", {
      predicate: (r) => r.method() === "POST" && r.url().includes("/api/csp-report"),
      timeout: 15_000,
    });

  await page.goto("/");

  // Same canary as the sanity test — img-src has no allowance for example.com.
  await page.evaluate(() => {
    const img = document.createElement("img");
    img.src = "https://example.com/csp-report-delivery-canary.png";
    document.body.appendChild(img);
  });

  const request = await reportPosted;
  const body = request.postData() ?? "";
  expect(body, "the delivered report should name the blocked canary").toContain("example.com");
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

// ---------------------------------------------------------------------------
// The `/embed/*` scope (Ed approved `frame-ancestors *` for this path only,
// 2026-09-11). Everything above this point asserts the ABSENCE of violations
// via the browser's own CSP engine; these assert the actual served header
// value, because a scoping bug here (the wrong rule winning, or the embed
// rule accidentally widening a directive other than frame-ancestors) would
// not show up as a "violation" in any browser — it would just silently be
// the wrong policy. `response.headers()` reads what the server actually
// sent, independent of whether the browser's CSP engine agrees with it.
//
// `app/embed/**` is being built by a parallel change and may not exist yet
// when this spec runs. Next.js applies header rules to a route's response
// regardless of status code (including a 404), so these assertions are
// deliberately scoped to the HEADERS of the response, not its body or
// status — they should pass whether the route 404s or renders.
// ---------------------------------------------------------------------------

test("/embed/states/or — Content-Security-Policy allows framing from any origin", async ({
  page,
}) => {
  const response = await page.goto("/embed/states/or");
  expect(response, "expected a response to /embed/states/or").not.toBeNull();

  const csp = response!.headers()["content-security-policy"];
  expect(csp, "expected a Content-Security-Policy header on the embed response").toBeDefined();
  expect(csp).toContain("frame-ancestors *");
});

test("/embed/states/or — the embed scope relaxes framing only, not the rest of the policy", async ({
  page,
}) => {
  const response = await page.goto("/embed/states/or");
  const csp = response!.headers()["content-security-policy"] ?? "";

  // Same hardening directives the site-wide and /admin scopes carry — proves
  // CSP_EMBED is the full shared policy plus a widened frame-ancestors, not
  // an independently-authored (and possibly weaker) one-off.
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'self'");
  expect(csp).toContain("default-src 'self'");
});

test("/admin/login — still refuses framing outright, embed scope did not leak in", async ({
  page,
}) => {
  const response = await page.goto("/admin/login");
  const headers = response!.headers();

  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["content-security-policy"]).not.toContain("frame-ancestors *");
  expect(headers["x-frame-options"]).toBe("DENY");
});

test("/ — still same-origin framing, embed scope did not leak in", async ({ page }) => {
  const response = await page.goto("/");
  const csp = response!.headers()["content-security-policy"] ?? "";

  expect(csp).toContain("frame-ancestors 'self'");
  expect(csp).not.toContain("frame-ancestors *");
});

// ---------------------------------------------------------------------------
// Frame-escape links (components/map/facility-map.tsx's linksOpenInNewTab,
// derived via isEmbedRoute() — see that prop's doc comment for the threat
// model: a soft next/link nav out of an `/embed/*` map would carry a visitor
// into `/facilities/[slug]`'s own, unvetted `frame-ancestors 'self'` without
// the browser ever re-evaluating it against the embedding page's origin).
//
// Everything above this point is a MOCKED-next/link unit test
// (facility-map.test.tsx, facility-popup.test.tsx) — that mock previously
// dropped `target`/`rel` entirely, which would have let this exact
// regression pass silently. These two tests assert against the REAL
// rendered DOM of a production build instead.
//
// Scoped to the always-rendered sr-only "data table page" link
// (facility-map.tsx), not the popup's "View details" link: FacilityMarker
// buttons are real positioned DOM elements (not canvas-drawn), so opening a
// popup is plausible in headless Chromium, but nothing in this repo's e2e
// suite currently drives a marker click, and doing so here would add a new,
// unproven interaction path (marker geometry + possible clustering at the
// state-level survey-pass zoom) to a regression test whose only job is
// proving `target`/`rel` land in real HTML. The sr-only link takes the exact
// same `escapeLinks` value and is guaranteed present regardless of how many
// facilities a state has or whether they cluster — so it's the more
// reliable signal for this specific regression. The popup link itself is
// NOT covered by a browser-level (non-mocked) assertion as of this test;
// that gap is a known residual, not an oversight.
// ---------------------------------------------------------------------------

test("/embed/states/texas — the sr-only data-table link escapes to a new top-level tab", async ({
  page,
}) => {
  await page.goto("/embed/states/texas");

  const link = page.getByRole("link", { name: /data table page/i });
  await expect(link).toHaveAttribute("target", "_blank");
  const rel = await link.getAttribute("rel");
  expect(rel).toContain("noopener");
});

test("/map — the same sr-only data-table link stays same-tab, proving the derivation discriminates by route", async ({
  page,
}) => {
  await page.goto("/map");
  await page.waitForSelector(".maplibregl-canvas-container", { state: "attached" });

  const link = page.getByRole("link", { name: /data table page/i });
  await expect(link).not.toHaveAttribute("target", "_blank");
});
