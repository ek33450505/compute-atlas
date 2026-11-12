import { test, expect } from "@playwright/test";

// Phone-width /table: rows render as cards and sorting moves to a "Sort by"
// select, so nothing the user filtered for sits off-screen.
const URL = "/table?status=operational&state=TX&type=data_center";

test.describe("/table on a phone", () => {
  test("does not scroll horizontally", async ({ page }) => {
    await page.goto(URL);
    await expect(page.getByRole("list", { name: "Facilities" })).toBeVisible();
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth).toBe(innerWidth);
  });

  test("shows status and capacity of a card inside the viewport", async ({ page }) => {
    await page.goto(URL);
    const card = page.getByRole("list", { name: "Facilities" }).getByRole("listitem").first();
    await expect(card).toBeVisible();
    const capacity = card.getByText(/\bMW\b|^—$/).first();
    const status = card.getByText("Operational", { exact: true });
    const viewport = page.viewportSize()!;
    for (const el of [capacity, status]) {
      await expect(el).toBeVisible();
      const box = (await el.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    }
    await expect(page.getByRole("table")).toBeHidden();
  });

  test("choosing a Sort by option writes sort and dir to the URL", async ({ page }) => {
    await page.goto(URL);
    await page.getByRole("combobox", { name: "Sort by" }).selectOption({ label: "Name, A to Z" });
    await expect(page).toHaveURL(/sort=name/);
    await expect(page).toHaveURL(/dir=asc/);
    await expect(page.getByRole("combobox", { name: "Sort by" })).toHaveValue("name:asc");
    const links = page.getByRole("list", { name: "Facilities" }).getByRole("listitem").getByRole("link");
    await expect(links.nth(1)).toBeVisible();
    // The URL changes before the server-rendered list does, so poll the order.
    await expect
      .poll(async () => {
        const first = (await links.nth(0).innerText()).trim();
        const second = (await links.nth(1).innerText()).trim();
        return first.localeCompare(second) <= 0;
      })
      .toBe(true);
  });
});
