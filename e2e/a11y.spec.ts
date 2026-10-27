import { test, expect } from "@playwright/test";
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
  "/methodology",
  "/api",
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
 * `/table` renders a row per facility, and axe's analysis is superlinear in
 * DOM nodes: at 1,145 facilities the scan took 29.6s against the 30s default
 * and passed with 0.4s to spare; the very next wave (1,197, +4.5%) took 32.8s
 * and failed on all three attempts. Nothing about the page's accessibility
 * changed — the budget was simply too tight to survive normal growth.
 *
 * `test.slow()` triples the per-test timeout (30s → 90s), which is ~2.7x the
 * current cost. That is headroom, not a fix: the underlying issue is that
 * `/table` puts the whole dataset in the DOM at once, which is also a real
 * user-facing weight problem. If this list needs a fourth entry, or `/table`
 * starts brushing 90s, paginate or virtualise the table instead of raising
 * this again.
 *
 * `/counties` joins it for the same shape of risk from a different cause: it
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
const DATASET_SIZED_ROUTES = new Set<string>(["/table", "/counties"]);

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

// The support banner is client-only and hidden for first-time visitors, so the
// route scans above never render it. Seed a returning visit (>= 2) to scan the
// banner itself, then confirm dismissal.
test("a11y: /about with the support banner — zero serious/critical violations", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("ca-support-banner:visits", "2");
  });
  // Keep axe from scanning mid-fade of the banner's entrance animation.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/about");
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
    `/about (banner): ${seriousOrCritical.map((v) => v.id).join(", ")}`,
  ).toHaveLength(0);

  await page.getByRole("button", { name: "Dismiss support message" }).click();
  await expect(banner).toBeHidden();
  // Session-scoped dismissal: a reload in the same session stays hidden. Assert
  // the flag was written first so the post-reload check is not vacuous.
  expect(
    await page.evaluate(() => sessionStorage.getItem("ca-support-banner:dismissed")),
  ).toBe("1");
  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(banner).toBeHidden();
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--support-bar-h"),
    ),
  ).toBe("");
});
