import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Routes under audit
const ROUTES = [
  "/",
  "/map",
  "/table",
  "/stats",
  "/about",
  "/support",
  "/facilities/meta-prineville-or",
  "/contact",
  "/access",
  "/access/confirm?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "/access/renew?token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "/access/confirmed",
  "/methodology",
  "/data",
  // Chrome-free layout shape (no header/footer, full-height map + a single
  // attribution link) — never audited before. "texas" is prerendered
  // (generateStaticParams iterates getStates(), i.e. states with
  // facilities) so this exercises the populated map, not the empty-state
  // branch; already used as a known-populated state in
  // e2e/prose-spacing.spec.ts.
  "/embed/states/texas",

  // The by-county lens, both shapes. The index renders a link per tracked
  // county (636 today) across ~50 nested <section>s, each with its own <h3>
  // under an sr-only <h2> — a heading outline and a link density nothing
  // else on the site has, and the largest new UI surface in this change.
  "/counties",
  // A per-county hub, pinned to a slug the way e2e/facility.spec.ts pins
  // meta-prineville-or. Deliberately the LARGEST county (45 facilities, more
  // than any other) so the scan sees a fully populated card grid: a
  // single-facility hub — 354 of the 636 qualify — would scan a near-empty
  // page and prove almost nothing about the template.
  "/counties/loudoun-va",

  // Pages never audited before. The lens/ranking/hub indexes are plain
  // server-rendered lists and tables, and /contribute and /access/commercial
  // carry forms and pricing copy; all are linked from the primary nav or footer.
  "/contribute",
  "/access/commercial",
  "/explore",
  "/states",
  "/operators",
  "/power",
  "/opposition",
  "/activity",
  "/rankings",
  "/crypto",
  "/ai",
  "/gaps",
  "/metros",
  "/status",
  "/stakeholders",
  // The e2e webServer builds from tests/fixtures/facilities.fixture.json (68
  // records, via ALLOW_FIXTURE_SNAPSHOT=1), so these slugs must exist THERE,
  // not in the live dataset. The facility template branches on facilityType
  // (different detail panels), and only data_center was audited, so scan one
  // of each remaining type. Both are single-record, populated pages chosen
  // from the fixture's own crypto_mining / power_generation entries.
  "/facilities/mara-granbury-hood-tx",
  "/facilities/crane-clean-energy-center-tmi-pa",
] as const;

// Tags covering WCAG 2.x AA + 2.2 AA
const AXE_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
] as const;

/**
 * Routes whose axe scan cost scales with the size of the dataset, so their
 * runtime grows on every data wave rather than staying put.
 *
 * `/table` used to be here: it rendered a row per facility, and axe's analysis
 * is superlinear in DOM nodes (55,293 nodes at 2,678 facilities; the scan
 * outgrew a 90s budget). It is now server-paginated at 50 rows a page, so its
 * DOM no longer grows with the dataset and it needs no extra budget. The
 * measurements below are kept for the routes that remain and as the record of
 * why the harness settings exist.
 *
 * `test.slow()` triples the per-test timeout (30s → 90s). That is headroom,
 * not a fix: if this list needs a second dataset-sized entry or `/counties`
 * starts brushing 90s, paginate it instead of raising this again.
 *
 * `/counties` is here for the same shape of risk from a different cause: it
 * renders one link per tracked county (636 today, growing with every data
 * wave) across ~50 nested sections. It is not a table, but axe does not care
 * what the nodes are — the cost is in the node count and the accessibility
 * tree depth, and both scale with the dataset here. Added at the same time as
 * the route itself rather than after a timeout, because that failure mode
 * presents as a flake and gets retried rather than diagnosed.
 *
 * Measured baseline, 2026-09-11 at 1,571 facilities / 636 counties:
 * `/counties` scans in 2.5s and `/counties/loudoun-va` (45 facilities, the
 * largest hub) in 1.2s — against `/table`'s 20.6s. So `/counties` is
 * nowhere near the ceiling today and its membership here is PRECAUTIONARY,
 * not a response to a measurement. Keeping it costs nothing: a timeout value
 * is only consulted when it is exceeded. Do not read this entry as evidence
 * that `/counties` is currently expensive — re-measure before citing it.
 *
 * Correction, 2026-10-17 (2,678 facilities, 55,293 DOM nodes on `/table`):
 * the 90s budget ran out in CI, and most of the scan was not the rules.
 * Measured locally (M-series) with axe's `performanceTimer`: the default scan
 * took 38.2s, of which the rules themselves (axe's `audit_start_to_end`) took
 * 17.3s. Two settings remove most of the rest, and neither does much alone:
 *   - By default `@axe-core/playwright` runs `axe.runPartial` in the page,
 *     then opens a blank page and hands it the partial results for
 *     `axe.finishRun`. `setLegacyMode(true)` runs plain `axe.run` in the page
 *     instead. On its own: 32.3s.
 *   - `resultTypes: ["violations"]` caps the passes, incomplete and
 *     inapplicable nodes that reach the report at one each. On its own
 *     (default mode): 37.4s.
 *   Together: 18.4s. The speedup comes from the two settings combined; this
 *   measures the scan alone. In CI the whole test, page load included,
 *   exceeded the 90s budget, so read the new CI figure from a CI log.
 * Rule and tag coverage is unchanged: the same WCAG tags run on every node
 * (asserted below via `toolOptions.runOnly`), and `violations` still lists
 * every failing node. Mutation-probed the same day by planting a missing alt, an
 * empty link and low-contrast text in the LAST of the 2,678 rows: both modes
 * reported the same three violations (image-alt, link-name, color-contrast).
 * The price of legacy mode: axe cannot reach into a cross-origin frame and
 * reports it as an INCOMPLETE `frame-tested` result. `frame-tested` is a
 * `best-practice` rule, so the WCAG-tag scan above never runs it and its
 * `incomplete` list cannot show it. The spec therefore runs a second, one-rule
 * legacy pass (`withRules(["frame-tested"])`, ~0.1s against ~8s for the tag
 * scan on a 24k-node synthetic page) and fails if it reports anything, so a
 * frame added to these routes, at load or later, fails loudly instead of going
 * unscanned. Probed in a scratch Chromium (axe-core 4.13, legacy mode,
 * `resultTypes: ["violations"]`, one-rule pass): a cross-origin frame yields a
 * `frame-tested` incomplete result (one node); a frameless page yields none.
 * A same-origin `srcdoc` frame (holding an `<img>` with no alt) depends on how
 * the page was loaded: on a page loaded from an http(s) URL the frame's
 * content WAS scanned (`image-alt` reported, no `frame-tested`), while on a
 * `page.setContent()` page it was NOT scanned (no `image-alt`, `frame-tested`
 * reported). `@axe-core/playwright` in legacy mode injects axe only into the
 * main frame, so do not assume any frame is covered; the guard fires for
 * every frame axe could not reach.
 * `test.slow()` stays as headroom.
 * The page's own DOM weight is still a real user-facing cost; this removes
 * harness overhead, not page weight.
 */
const DATASET_SIZED_ROUTES = new Set<string>(["/counties"]);

for (const route of ROUTES) {
  test(`a11y: ${route} — zero serious/critical violations`, async ({
    page,
  }) => {
    if (DATASET_SIZED_ROUTES.has(route)) test.slow();

    await page.goto(route);

    // Wait for the page to settle before scanning
    await page.waitForLoadState("networkidle");

    // NOTE: `playwright.config.ts` sets `reducedMotion: "reduce"` project-wide.
    // Without it, this scan measures RENDERED color mid-way through the
    // scroll-driven `.plate-reveal` entrance animation on `/` (below-fold
    // elements sit mid-fade), producing a false color-contrast violation even
    // though the underlying tokens are AA-clear. The animation only runs under
    // `prefers-reduced-motion: no-preference`, so forcing "reduce" here tests
    // the accessible path real reduced-motion users get — do not remove it to
    // "clean up" the config; that reintroduces the false failure.
    const builder = new AxeBuilder({ page });
    // Legacy mode + violations-only results on the dataset-sized routes; see
    // the 2026-10-17 correction on DATASET_SIZED_ROUTES. `.options()` REPLACES
    // the builder's option object, which is where `.withTags()` stores
    // `runOnly`, so it has to run BEFORE `.withTags()`.
    if (DATASET_SIZED_ROUTES.has(route)) {
      builder.setLegacyMode(true).options({ resultTypes: ["violations"] });
    }
    const results = await builder.withTags([...AXE_TAGS]).analyze();

    // Guards that ordering: had `.options()` run after `.withTags()`, axe would
    // silently scan with every rule instead of these tags and still pass.
    expect(results.toolOptions.runOnly).toEqual({
      type: "tag",
      values: [...AXE_TAGS],
    });

    // Legacy mode cannot scan a cross-origin frame; it reports one as an
    // INCOMPLETE `frame-tested`, a rule the WCAG tags above do not select, so
    // run it on its own (see DATASET_SIZED_ROUTES).
    if (DATASET_SIZED_ROUTES.has(route)) {
      const frames = await new AxeBuilder({ page })
        .setLegacyMode(true)
        .options({ resultTypes: ["violations"] })
        .withRules(["frame-tested"])
        .analyze();
      // Same ordering guard as the first pass: without it this could silently
      // run every rule (or none) and still pass.
      expect(frames.toolOptions.runOnly).toEqual({
        type: "rule",
        values: ["frame-tested"],
      });
      expect(
        frames.incomplete.filter((r) => r.id === "frame-tested"),
        `${route} has a frame axe's legacy mode could not scan; it would go unchecked`,
      ).toEqual([]);
    }

    // Separate by impact tier
    const seriousOrCritical = results.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical"
    );
    const moderateOrMinor = results.violations.filter(
      (v) => v.impact === "moderate" || v.impact === "minor"
    );

    // Log moderate/minor as informational (not a test failure)
    if (moderateOrMinor.length > 0) {
      console.warn(
        `[${route}] ${moderateOrMinor.length} moderate/minor violation(s) (not failing):`,
        moderateOrMinor.map((v) => ({
          rule: v.id,
          impact: v.impact,
          description: v.description,
        }))
      );
    }

    // Build a human-readable failure message if serious/critical found
    if (seriousOrCritical.length > 0) {
      const details = seriousOrCritical.map((v) => ({
        rule: v.id,
        impact: v.impact,
        description: v.description,
        affectedNodes: v.nodes.slice(0, 3).map((n) => n.target.join(", ")),
      }));
      // Print details so CI logs are actionable
      console.error(
        `[${route}] serious/critical violations:\n${JSON.stringify(details, null, 2)}`
      );
    }

    expect(
      seriousOrCritical,
      `${route}: expected 0 serious/critical WCAG violations but found ${seriousOrCritical.length}: ${seriousOrCritical.map((v) => v.id).join(", ")}`
    ).toHaveLength(0);
  });
}

/**
 * Scan the page as it stands, for the open-overlay tests below. Same tags and
 * the same runOnly guard as the route loop; no `.options()` call, so
 * `.withTags()` is the only thing setting runOnly. Nothing is excluded from
 * the scan and no rule is disabled. `include` optionally scopes the scan to
 * one subtree (a chained `.include()`, not `.options()`, so runOnly survives).
 */
async function expectNoSeriousOrCritical(
  page: Page,
  label: string,
  include?: string,
): Promise<void> {
  const builder = new AxeBuilder({ page });
  if (include) builder.include(include);
  const results = await builder.withTags([...AXE_TAGS]).analyze();
  expect(results.toolOptions.runOnly).toEqual({
    type: "tag",
    values: [...AXE_TAGS],
  });
  const seriousOrCritical = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  if (seriousOrCritical.length > 0) {
    console.error(
      `[${label}] serious/critical violations:\n${JSON.stringify(
        seriousOrCritical.map((v) => ({
          rule: v.id,
          impact: v.impact,
          description: v.description,
          affectedNodes: v.nodes.slice(0, 3).map((n) => n.target.join(", ")),
        })),
        null,
        2,
      )}`,
    );
  }
  expect(
    seriousOrCritical,
    `${label}: expected 0 serious/critical WCAG violations but found ${seriousOrCritical.length}: ${seriousOrCritical.map((v) => v.id).join(", ")}`,
  ).toHaveLength(0);
}

// Open-overlay states. The route scans above only see a page at rest, so none
// of these surfaces (portalled dialog, slide-in sheet, map popup, validation
// errors) was ever scanned while showing.

// The accessible name is "Search ⌘K" or "Search Ctrl K" by platform, so match
// the stable prefix. The button is rendered at every width (only its text label
// hides below `sm`), so this runs under both projects.
test("a11y: ⌘K command palette open — zero serious/critical violations", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page
    .locator("header")
    .getByRole("button", { name: /^Search (⌘K|Ctrl K)$/ })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Search Compute Atlas" }),
  ).toBeVisible();
  await expect(page.getByRole("combobox")).toBeFocused();
  await expectNoSeriousOrCritical(page, "command palette");
});

// Zero-result state: the listbox has no options and the "No matches" message
// (with its contribute link) renders beside it.
test("a11y: ⌘K command palette, no results — zero serious/critical violations", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await page
    .locator("header")
    .getByRole("button", { name: /^Search (⌘K|Ctrl K)$/ })
    .click();
  await page.getByRole("combobox").fill("zzzzqqq");
  await expect(page.getByText(/No matches for/)).toBeVisible();
  await expectNoSeriousOrCritical(page, "command palette (no results)");
});

// The hamburger is `xl:hidden` (1280px), so pin a phone width rather than rely
// on the project's viewport.
test.describe("mobile nav sheet", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a11y: mobile navigation open at 390px — zero serious/critical violations", async ({
    page,
  }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Open navigation menu" }).click();
    await expect(
      page.getByRole("navigation", { name: "Mobile navigation" }),
    ).toBeVisible();
    await expectNoSeriousOrCritical(page, "mobile nav (390px)");
  });
});

// A facility marker only exists once clustering has resolved to single pins, so
// zoom into clusters until one appears. Cluster buttons are named "Cluster of
// N datacenters"; anything else inside a maplibre marker is a facility pin.
test("a11y: /map popup open — zero serious/critical violations", async ({
  page,
}) => {
  await page.goto("/map");
  await page.waitForSelector(".maplibregl-canvas-container", {
    state: "attached",
  });
  const pins = page.locator(
    '.maplibregl-marker button:not([aria-label^="Cluster of"])',
  );
  const clusters = page.locator(
    '.maplibregl-marker button[aria-label^="Cluster of"]',
  );
  await expect
    .poll(async () => (await pins.count()) + (await clusters.count()), {
      message: "map never rendered a marker",
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  for (let i = 0; i < 12 && (await pins.count()) === 0; i++) {
    await clusters.first().click();
    // Let the zoom animation and re-cluster settle before looking again.
    await page.waitForTimeout(1000);
  }
  expect(await pins.count(), "no single-facility pin reachable").toBeGreaterThan(0);
  await pins.first().click();
  await expect(page.locator(".atlas-popup")).toBeVisible();
  // Scoped to the popup: the rest of /map is scanned at rest by the route loop
  // on both projects. A whole-page scan here also hits a separate defect, a
  // cluster marker partly under the legend toggle at phone width (WCAG 2.5.8
  // target-size), tracked in issue #572, which says nothing about the popup.
  await expectNoSeriousOrCritical(page, "/map (popup open)", ".atlas-popup");
});

// Submit the empty lead form so the validation errors (role="alert" messages,
// aria-invalid fields) are on screen when axe runs.
test("a11y: /contribute lead form validation errors — zero serious/critical violations", async ({
  page,
}) => {
  await page.goto("/contribute");
  await page.waitForLoadState("networkidle");
  const submit = page.getByRole("button", { name: "Submit link" });
  await submit.click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  // The button is disabled while the request is in flight; scan the settled
  // state, not the pending one.
  // (The pending/disabled state is not scanned here; the contribute form
  // vitest tests assert its classes instead.)
  await expect(submit).toBeEnabled();
  await expectNoSeriousOrCritical(page, "/contribute (validation errors)");
});

// The support banner is client-only and never shows on a session's first page
// view (D7), so the route scans above never render it. Reach a non-excluded
// route as the session's second page view to scan the banner itself, then
// confirm dismissal. (/about is excluded: it carries its own support section.)
test("a11y: /table with the support banner — zero serious/critical violations", async ({
  page,
}) => {
  // Keep axe from scanning mid-fade of the banner's entrance animation.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/stats");
  // Wait for hydration to count view 1; a full load that navigates away before
  // the mount effect runs would leave the session at one view.
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem("ca-support-banner:pageviews")), {
      timeout: 15_000,
    })
    .toBe("1");
  await page.goto("/table");
  await page.waitForLoadState("networkidle");

  const banner = page.getByRole("region", { name: "Support Compute Atlas" });
  await expect(banner).toBeVisible();

  // No `.options()` here, so `.withTags()` is the only thing setting runOnly.
  const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
  expect(results.toolOptions.runOnly).toEqual({
    type: "tag",
    values: [...AXE_TAGS],
  });
  const seriousOrCritical = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    seriousOrCritical,
    `/table (banner): ${seriousOrCritical.map((v) => v.id).join(", ")}`,
  ).toHaveLength(0);

  await page.getByRole("button", { name: "Dismiss support message" }).click();
  await expect(banner).toBeHidden();
  // Session-scoped dismissal: a reload in the same session stays hidden. Assert
  // the flag was written first so the post-reload check is not vacuous.
  expect(
    await page.evaluate(() => sessionStorage.getItem("ca-support-banner:dismissed")),
  ).toBe("1");
  // Positive hydration signal: the banner's mount effect deletes this legacy
  // localStorage key before it reads the session flag, so its disappearance
  // proves the effect ran. Without it, "hidden" also holds before hydration
  // (the card renders nothing on the server) and the check below is vacuous.
  await page.evaluate(() =>
    window.localStorage.setItem("ca-support-banner:dismissed", "legacy"),
  );
  // `load`, not `networkidle`: after a reload the header's route prefetches
  // can keep the network busy past the test timeout on a slow CI runner.
  await page.reload({ waitUntil: "load" });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.localStorage.getItem("ca-support-banner:dismissed"),
        ),
      { timeout: 15_000 },
    )
    .toBeNull();
  // The effect has run; let any state update it queued commit before asserting.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await expect(banner).toBeHidden();
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--support-bar-h"),
    ),
  ).toBe("");
});

// Regression: the hero globe's aria-hidden canvas must be non-focusable from the moment maplibre
// creates it, not only after `load`. With the basemap requests failing, `load` never fires, so a
// strip that only ran on load left a focusable canvas inside aria-hidden (axe aria-hidden-focus).
test("a11y: / — hero globe canvas is never focusable, even if the basemap never loads", async ({ page }, testInfo) => {
  // hero-globe-dynamic.tsx only mounts the MapLibre globe once
  // `matchMedia("(min-width: 640px)")` matches; a phone gets the static plate
  // and no canvas exists to be focusable.
  test.skip(
    testInfo.project.name === "Mobile Chrome",
    "hero globe is not mounted below 640px (hero-globe-dynamic.tsx allowGlobe gate)",
  );
  await page.route(/\/basemap\//, (route) => route.abort());
  await page.goto("/");
  const canvas = page.locator("canvas.maplibregl-canvas").first();
  await expect(canvas).toBeAttached();
  await expect(canvas).toHaveAttribute("tabindex", "-1");
});
