import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// 404 — unknown slug
// ---------------------------------------------------------------------------
// Regression coverage for a soft-404: a loading.tsx colocated with this
// dynamic segment wrapped the page in a Suspense boundary, which committed
// the HTTP response to 200 before the page's notFound() call (thrown after
// an awaited DB lookup) could take effect. The rendered body correctly
// showed "Operator not found," but the status code stayed 200. See
// app/operators/[operator]/page.tsx — fixed by removing loading.tsx to match
// the sibling route families (metros/status/learn) that never had one.

test("/operators/does-not-exist returns HTTP 404", async ({ page }) => {
  const response = await page.goto("/operators/does-not-exist");
  expect(response?.status()).toBe(404);
});
