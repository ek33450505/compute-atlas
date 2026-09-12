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
    const results = await new AxeBuilder({ page })
      .withTags([...AXE_TAGS])
      .analyze();

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
