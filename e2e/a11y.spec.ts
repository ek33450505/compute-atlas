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
 */
const DATASET_SIZED_ROUTES = new Set<string>(["/table"]);

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
