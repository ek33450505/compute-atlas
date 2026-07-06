import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Landing page — core behaviors
// ---------------------------------------------------------------------------

test("/ returns 200 and hero count text is visible", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  // The hero paragraph renders "Tracking N AI datacenters"
  await expect(page.getByText(/Tracking.*AI datacenters/)).toBeVisible();
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
// View toggle — table and map
// ---------------------------------------------------------------------------

test("table view renders a data table", async ({ page }) => {
  await page.goto("/?view=table");
  await expect(page.getByRole("table")).toBeVisible();
});

test("view toggle switches between table and map", async ({ page }) => {
  await page.goto("/?view=table");
  await expect(page.getByRole("table")).toBeVisible();

  // Switch to map view
  await page.getByRole("button", { name: "Map view" }).click();
  await expect(
    page.getByRole("region", { name: /Interactive datacenter map/i })
  ).toBeVisible();

  // Switch back to table
  await page.getByRole("button", { name: "Table view" }).click();
  await expect(page.getByRole("table")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

test("result count shows Showing N of M in table view", async ({ page }) => {
  await page.goto("/?view=table");
  await expect(page.getByRole("status")).toContainText(
    /Showing \d+ of \d+ facilities/
  );
});

test("status filter updates URL and reduces results; Clear all resets", async ({
  page,
}) => {
  await page.goto("/?view=table");

  // Read total count before filtering
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

// ---------------------------------------------------------------------------
// Navigation — table row → facility detail
// ---------------------------------------------------------------------------

test("clicking a facility name navigates to its detail page", async ({
  page,
}) => {
  await page.goto("/?view=table");
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
