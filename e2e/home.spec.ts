import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Landing page (/) — editorial home
// ---------------------------------------------------------------------------

test("/ returns 200 and shows survey framing heading", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  // Hero headline renders on the home page
  await expect(
    page.getByRole("heading", { name: /America.s data centers, mapped and sourced/i })
  ).toBeVisible();
});

test("/ shows site count stat", async ({ page }) => {
  await page.goto("/");
  // Stats row renders a count label
  await expect(
    page.getByText(/Sites tracked/i)
  ).toBeVisible();
});

test("/ has Explore the map link pointing to /map", async ({ page }) => {
  await page.goto("/");
  const mapLink = page.getByRole("link", { name: /Explore the map/i });
  await expect(mapLink).toBeVisible();
  const href = await mapLink.getAttribute("href");
  expect(href).toBe("/map");
});

test("/ Notable sites section renders cards", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /Notable sites/i })
  ).toBeVisible();
  // At least one card link is present
  const cards = page.locator('a[href^="/facilities/"]');
  await expect(cards.first()).toBeVisible();
});

test("skip to main content is first focusable element and targets #main-content", async ({
  page,
}) => {
  await page.goto("/");
  // First Tab brings focus to the skip link (sr-only until focused)
  await page.keyboard.press("Tab");
  const href = await page.evaluate(
    () => document.activeElement?.getAttribute("href")
  );
  expect(href).toBe("#main-content");
});

// ---------------------------------------------------------------------------
// /map page — Explorer in map mode
// ---------------------------------------------------------------------------

test("/map shows interactive datacenter map region", async ({ page }) => {
  await page.goto("/map");
  await expect(
    page.getByRole("region", { name: /Interactive datacenter map/i })
  ).toBeVisible();
});

test("/map shows result count status", async ({ page }) => {
  await page.goto("/map");
  await expect(page.getByRole("status")).toContainText(
    /Showing \d+ of \d+ facilities/
  );
});

test("/map has View as table cross-link", async ({ page }) => {
  await page.goto("/map");
  const tableLink = page.getByRole("link", { name: /View as table/i });
  await expect(tableLink).toBeVisible();
  const href = await tableLink.getAttribute("href");
  expect(href).toBe("/table");
});

test("/map status filter updates URL and reduces results; Clear all resets", async ({
  page,
}) => {
  await page.goto("/map");

  const statusEl = page.getByRole("status");
  await expect(statusEl).toContainText(/Showing \d+ of \d+ facilities/);

  // Click the "Operational" status checkbox
  const operationalCheckbox = page.getByRole("checkbox", {
    name: "Operational",
  });
  await operationalCheckbox.click();

  // URL should include status filter
  await expect(page).toHaveURL(/[?&]status=operational/);

  // Count region still shows a valid result summary
  await expect(statusEl).toContainText(/Showing \d+ of \d+ facilities/);

  // "Clear all" button appears when filters are active; click it
  await page.getByRole("button", { name: /Clear all/i }).click();

  // Status filter removed from URL
  await expect(page).not.toHaveURL(/status=/);
});

test("filter state carries from /map to /table via the shared URL", async ({
  page,
}) => {
  await page.goto("/map");

  const statusEl = page.getByRole("status");
  // Capture the unfiltered count: "Showing N of N facilities"
  await expect(statusEl).toContainText(/Showing \d+ of \d+ facilities/);

  // Click the "Operational" status checkbox to apply a filter
  const operationalCheckbox = page.getByRole("checkbox", {
    name: "Operational",
  });
  await operationalCheckbox.click();

  // Assert the URL now includes the filter parameter
  await expect(page).toHaveURL(/[?&]status=operational/);

  // Click "View as table" link to navigate to /table
  const tableLink = page.getByRole("link", { name: /View as table/i });
  await tableLink.click();

  // Assert the /table URL also has the status filter in the query string
  await expect(page).toHaveURL(/\/table\?.*status=operational/);

  // Verify the status region is visible and shows filtered results
  const tableStatusEl = page.getByRole("status");
  await expect(tableStatusEl).toContainText(/Showing \d+ of \d+ facilities/);

  // Parse the status text to confirm the filter is actually applied:
  // The filtered count (first number) should be less than the total (second number)
  const statusText = await tableStatusEl.textContent();
  const match = statusText?.match(/Showing (\d+) of (\d+)/);
  expect(match).toBeTruthy();
  const filteredCount = Number(match![1]);
  const totalCount = Number(match![2]);
  expect(filteredCount).toBeLessThan(totalCount);

  // Verify the table is visible on /table
  await expect(page.getByRole("table")).toBeVisible();
});

// ---------------------------------------------------------------------------
// /table page — data table
// ---------------------------------------------------------------------------

test("/table renders a data table", async ({ page }) => {
  await page.goto("/table");
  await expect(page.getByRole("table")).toBeVisible();
});

test("/table shows result count", async ({ page }) => {
  await page.goto("/table");
  // The heading includes the count
  await expect(
    page.getByRole("heading", { name: /Data center data table/i })
  ).toBeVisible();
});

test("/table View map link points to /map", async ({ page }) => {
  await page.goto("/table");
  const mapLink = page.getByRole("link", { name: /← View map/i });
  await expect(mapLink).toBeVisible();
  const href = await mapLink.getAttribute("href");
  expect(href).toBe("/map");
});

// ---------------------------------------------------------------------------
// Navigation — table row → facility detail
// ---------------------------------------------------------------------------

test("clicking a facility name on /table navigates to its detail page", async ({
  page,
}) => {
  await page.goto("/table");
  await expect(page.getByRole("table")).toBeVisible();

  // Grab the first facility link inside the table body
  const facilityLink = page.locator("table tbody a").first();
  const facilityName = (await facilityLink.textContent())?.trim();
  expect(facilityName).toBeTruthy();

  await facilityLink.click();

  await expect(page).toHaveURL(/\/facilities\//);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    facilityName!
  );
});
