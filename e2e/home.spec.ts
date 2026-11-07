import { test, expect, devices } from "@playwright/test";

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
  // /map has two role="status" live regions (result-count subheader +
  // location-search jump-to status); scope to the one with text so this
  // doesn't hit a strict-mode violation once both are mounted.
  await expect(
    page.getByRole("status").filter({ hasText: /Showing/ })
  ).toContainText(/Showing [\d,]+ of [\d,]+ facilities/);
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

  // /map has two role="status" live regions (result-count subheader +
  // location-search jump-to status); scope to the one with text so this
  // doesn't hit a strict-mode violation once both are mounted.
  const statusEl = page.getByRole("status").filter({ hasText: /Showing/ });
  await expect(statusEl).toContainText(/Showing [\d,]+ of [\d,]+ facilities/);

  // Click the "Operational" status checkbox
  const operationalCheckbox = page.getByRole("checkbox", {
    name: "Operational",
  });
  await operationalCheckbox.click();

  // URL should include status filter
  await expect(page).toHaveURL(/[?&]status=operational/);

  // Count region still shows a valid result summary
  await expect(statusEl).toContainText(/Showing [\d,]+ of [\d,]+ facilities/);

  // "Clear all" button appears when filters are active; click it
  await page.getByRole("button", { name: /Clear all/i }).click();

  // Status filter removed from URL
  await expect(page).not.toHaveURL(/status=/);
});

test("filter state carries from /map to /table via the shared URL", async ({
  page,
}) => {
  await page.goto("/map");

  // /map has two role="status" live regions (result-count subheader +
  // location-search jump-to status); scope to the one with text so this
  // doesn't hit a strict-mode violation once both are mounted.
  const statusEl = page.getByRole("status").filter({ hasText: /Showing/ });
  // Capture the unfiltered count: "Showing N of N facilities"
  await expect(statusEl).toContainText(/Showing [\d,]+ of [\d,]+ facilities/);
  const parseMapCounts = async () => {
    const m = (await statusEl.textContent())?.match(/Showing ([\d,]+) of ([\d,]+)/);
    expect(m).toBeTruthy();
    return {
      shown: Number(m![1].replace(/,/g, "")),
      total: Number(m![2].replace(/,/g, "")),
    };
  };
  const { total: unfilteredTotal } = await parseMapCounts();

  // Click the "Operational" status checkbox to apply a filter
  const operationalCheckbox = page.getByRole("checkbox", {
    name: "Operational",
  });
  await operationalCheckbox.click();

  // Assert the URL now includes the filter parameter
  await expect(page).toHaveURL(/[?&]status=operational/);

  // Wait for the map's filtered count to drop below the unfiltered total
  await expect
    .poll(async () => (await parseMapCounts()).shown)
    .toBeLessThan(unfilteredTotal);
  const { shown: mapFilteredCount } = await parseMapCounts();

  // Click "View as table" link to navigate to /table
  const tableLink = page.getByRole("link", { name: /View as table/i });
  await tableLink.click();

  // Assert the /table URL also has the status filter in the query string
  await expect(page).toHaveURL(/\/table\?.*status=operational/);

  // Verify the status region is visible and shows filtered results.
  // Scoped defensively like the /map lookups above — /table only has one
  // role="status" today (no location-search control in table view), but
  // filtering keeps this locator correct if that ever changes.
  const tableStatusEl = page
    .getByRole("status")
    .filter({ hasText: /Showing/ });
  // /table is server-paginated: "Showing 1–50 of N facilities" (en dash), where
  // N is the FILTERED total.
  await expect(tableStatusEl).toContainText(
    /Showing 1–[\d,]+ of [\d,]+ facilities/
  );

  // Same filter, same dataset: the table total must equal the map's filtered
  // count and be smaller than the unfiltered total.
  const statusText = await tableStatusEl.textContent();
  const match = statusText?.match(/Showing 1–[\d,]+ of ([\d,]+) facilities/);
  expect(match).toBeTruthy();
  const tableTotal = Number(match![1].replace(/,/g, ""));
  expect(tableTotal).toBe(mapFilteredCount);
  expect(tableTotal).toBeLessThan(unfilteredTotal);

  // Verify the table is visible on /table
  await expect(page.getByRole("table")).toBeVisible();
});

test("/table paginates through real links and keeps the query", async ({ page }) => {
  await page.goto("/table");
  const nav = page.getByRole("navigation", { name: "Table pagination" });
  await expect(nav).toBeVisible();
  const status = page.getByRole("status").filter({ hasText: /Showing/ });
  await expect(status).toContainText(/Showing 1–50 of [\d,]+ facilities/);
  const total = Number(/of ([\d,]+) facilities/.exec((await status.textContent()) ?? "")?.[1].replace(/,/g, ""));
  // Fewer than two pages would make this test pass without paginating anything.
  expect(total, "pagination is untestable with <= 50 facilities").toBeGreaterThan(50);
  await nav.getByRole("link", { name: "Next" }).click();
  await expect(page).toHaveURL(/[?&]page=2/);
  await expect(status).toContainText(new RegExp(`Showing 51–${Math.min(100, total)} of [\\d,]+ facilities`));
  await expect(
    page.getByRole("navigation", { name: "Table pagination" }).getByRole("link", { name: "Page 2" })
  ).toHaveAttribute("aria-current", "page");
});

test("/table sorts from the header and resets to page 1", async ({ page }) => {
  await page.goto("/table?page=2");
  await page.getByRole("button", { name: "Sort by Name" }).click();
  await expect(page).toHaveURL(/[?&]sort=name/);
  await expect(page).not.toHaveURL(/[?&]page=/);
  await expect(page.getByRole("columnheader", { name: /name/i })).toHaveAttribute(
    "aria-sort",
    "ascending"
  );
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

// Regression for F-3: on phones the cartouche is taller than the hero box, and
// its opaque scrim used to cover the whole absolutely-positioned dot plate, so
// the only map phones get was invisible. The plate must be in flow, below the
// text, and actually hit-testable at its centre.
test.describe("hero plate on a phone", () => {
  // Viewport only: a full device descriptor carries defaultBrowserType, which
  // Playwright refuses inside a describe group.
  test.use({ viewport: devices["iPhone 13"].viewport, isMobile: true });

  test("/ hero dot plate is visible and not covered", async ({ page }) => {
    await page.goto("/");
    const plate = page.locator(".hero-plate-vt");
    await expect(plate).toBeVisible();
    await plate.scrollIntoViewIfNeeded();

    const covered = await plate.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.x + box.width / 2,
        box.y + box.height / 2
      );
      return { height: box.height, inside: hit !== null && el.contains(hit) };
    });
    expect(covered.height).toBeGreaterThan(200);
    expect(covered.inside).toBe(true);
  });

  // F-4: an `sr-only` <table> sizes to its content (CSS 2.1 auto layout), so
  // the StackArea data table widened the layout viewport (scrollWidth 761 at
  // 390px, measured 2026-10-15). Relies on this describe's phone viewport.
  test("/ does not scroll sideways", async ({ page }) => {
    await page.goto("/");
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  });
});
