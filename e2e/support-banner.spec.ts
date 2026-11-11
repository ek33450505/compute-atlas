import { test, expect } from "@playwright/test";

// D7 (2026-11-11): on phones the support banner is in document flow above the
// footer, so it can never cover a primary action.
test.use({ viewport: { width: 375, height: 812 } });

test("phone: the support banner is in flow and never covers the primary link", async ({
  page,
}) => {
  // page.goto is a full load, but sessionStorage survives in the same tab, so
  // the per-session page-view count accumulates across loads. goto resolves at
  // `load`, before React hydrates: navigating away at once skips the banner's
  // mount effect and the view goes uncounted (observed: 2 views for 3 loads).
  // So wait for each view's count to be written, a positive hydration signal.
  const views = () => page.evaluate(() => sessionStorage.getItem("ca-support-banner:pageviews"));
  for (const [i, path] of ["/", "/table", "/"].entries()) {
    await page.goto(path);
    await expect.poll(views, { timeout: 15_000 }).toBe(String(i + 1));
  }

  const banner = page.locator('section[aria-label="Support Compute Atlas"]');
  // No animation dependency: the e2e build runs with reducedMotion "reduce".
  await expect(banner).toBeVisible();
  await expect(banner).not.toHaveCSS("position", "fixed");

  const link = page.getByRole("link", { name: "Explore the map" }).first();
  await link.scrollIntoViewIfNeeded();
  const hit = await link.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top !== null && (top === el || el.contains(top));
  });
  expect(hit).toBe(true);
});
