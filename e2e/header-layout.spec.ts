import { test, expect } from "@playwright/test";

// The site header row is pinned to the left edge at every width, matching the
// full-width admin bar (app/admin/layout.tsx). Measured in a real browser:
// a max-w-7xl + mx-auto row starts near x=370 on a 2000px screen.
const WIDTHS = [375, 768, 1280, 2000];

for (const width of WIDTHS) {
  test.describe(`header at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("wordmark sits at the left edge and the header spans the viewport", async ({ page }) => {
      await page.goto("/");
      const header = page.locator("header").first();
      const home = header.getByRole("link", { name: /home$/ }).first();
      await expect(home).toBeVisible();
      const box = (await home.boundingBox())!;
      expect(box.x).toBeLessThanOrEqual(24);
      const headerBox = (await header.boundingBox())!;
      expect(headerBox.x).toBe(0);
      expect(headerBox.width).toBe(width);
    });

    test("wordmark x matches the admin bar's first link", async ({ page }) => {
      test.skip(width < 640, "admin bar alignment is asserted from sm up");
      await page.goto("/admin/login");
      const home = page.locator("header").first().getByRole("link", { name: /home$/ }).first();
      const adminLink = page.getByRole("link", { name: "Compute Atlas Admin" });
      await expect(home).toBeVisible();
      await expect(adminLink).toBeVisible();
      const homeX = (await home.boundingBox())!.x;
      const adminX = (await adminLink.boundingBox())!.x;
      expect(Math.abs(homeX - adminX)).toBeLessThanOrEqual(1);
    });
  });
}

test("screenshots of / at four widths", async ({ page }, info) => {
  test.skip(!process.env.HEADER_SHOTS_DIR, "set HEADER_SHOTS_DIR to capture");
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.screenshot({ path: `${process.env.HEADER_SHOTS_DIR}/home-${width}-${info.project.name}.png` });
  }
});
