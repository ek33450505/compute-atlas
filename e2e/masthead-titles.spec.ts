import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Masthead-titles guard — an eyebrow (the small uppercase kicker above the h1)
// must ADD information: name a section or category, never repeat the h1.
// A single-item breadcrumb that equals the h1 adds nothing either.
// (Ed, 2026-11-11; /data stacked breadcrumb "Data" + eyebrow "DATA" + h1 "Data".)
// ---------------------------------------------------------------------------
//
// Reads the rendered DOM: the eyebrow is the <p> immediately before the h1.
// Dynamic routes use slugs present in the e2e fixture snapshot
// (as in prose-spacing.spec.ts). /subscribe pages that need a valid token are
// left out; only the token-free states are covered.
const ROUTES = [
  "/data",
  "/methodology",
  "/support",
  "/crypto",
  "/counties",
  "/metros",
  "/operators",
  "/states",
  "/power",
  "/ai",
  "/opposition",
  "/stakeholders",
  "/about",
  "/states/texas",
  "/operators/google",
  "/subscribe/confirmed",
  "/subscribe/unsubscribed",
  "/subscribe/invalid",
];

const norm = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

for (const route of ROUTES) {
  test(`masthead titles do not repeat the h1: ${route}`, async ({ page }) => {
    await page.goto(route);
    const h1 = page.locator("h1").first();
    await expect(h1).toBeVisible();
    const title = norm(await h1.textContent());

    const eyebrow = h1.locator("xpath=preceding-sibling::*[1][self::p]");
    if ((await eyebrow.count()) > 0) {
      const kicker = norm(await eyebrow.textContent());
      expect(kicker, "eyebrow must not equal the h1").not.toBe(title);
      const words = title.split(/[^a-z0-9]+/);
      const phrase = kicker.split(/[^a-z0-9]+/).join(" ");
      expect(` ${words.join(" ")} `, "eyebrow must not be contained in the h1").not.toContain(` ${phrase} `);
    }

    const crumbs = page.locator('nav[aria-label*="readcrumb" i] li');
    if ((await crumbs.count()) === 1) {
      expect(norm(await crumbs.first().textContent()), "lone breadcrumb must not equal the h1").not.toBe(title);
    }
  });
}
