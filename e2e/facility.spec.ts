import { test, expect } from "@playwright/test";

// Known facility used throughout: Meta Prineville Data Center Campus
const KNOWN_SLUG = "meta-prineville-or";
const KNOWN_NAME = "Meta Prineville Data Center Campus";

// ---------------------------------------------------------------------------
// Known facility page
// ---------------------------------------------------------------------------

test(`${KNOWN_SLUG} renders h1 with facility name`, async ({ page }) => {
  await page.goto(`/facilities/${KNOWN_SLUG}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(KNOWN_NAME);
});

test(`${KNOWN_SLUG} shows a status badge`, async ({ page }) => {
  await page.goto(`/facilities/${KNOWN_SLUG}`);
  // Meta Prineville is "operational" — badge label is "Operational"
  await expect(page.getByText("Operational").first()).toBeVisible();
});

test(`${KNOWN_SLUG} has "Sources & data provenance" section with at least one external link`, async ({
  page,
}) => {
  await page.goto(`/facilities/${KNOWN_SLUG}`);

  // Section heading is visible
  await expect(
    page.getByRole("heading", { name: /Sources & data provenance/i })
  ).toBeVisible();

  // At least one external source link inside that section
  const provenance = page.locator("section").filter({
    has: page.getByText(/Sources & data provenance/),
  });
  await expect(
    provenance.locator('a[target="_blank"]').first()
  ).toBeVisible();
});

test(`${KNOWN_SLUG} renders status timeline list`, async ({ page }) => {
  await page.goto(`/facilities/${KNOWN_SLUG}`);
  // StatusTimeline renders <ol aria-label="Status history">
  const timeline = page.getByRole("list", { name: /Status history/i });
  await expect(timeline).toBeVisible();
  // Should have at least one list item
  await expect(timeline.locator("li").first()).toBeVisible();
});

// ---------------------------------------------------------------------------
// 404 — unknown slug
// ---------------------------------------------------------------------------

test("/facilities/does-not-exist returns HTTP 404", async ({ page }) => {
  const response = await page.goto("/facilities/does-not-exist");
  expect(response?.status()).toBe(404);
});
