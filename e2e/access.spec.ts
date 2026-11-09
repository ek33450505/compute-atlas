import { test, expect } from "@playwright/test";

const TOKEN = "A".repeat(43);

test("/access serves the request form", async ({ page }) => {
  const response = await page.goto("/access");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Dataset access" })).toBeVisible();
  await expect(page.getByRole("button", { name: /request access/i })).toBeVisible();
});

for (const [kind, button] of [
  ["confirm", "Confirm this request"],
  ["renew", "Request renewal"],
] as const) {
  test(`/access/${kind} is no-store and renders a POST form for a valid token`, async ({ page, request }) => {
    const url = `/access/${kind}?token=${TOKEN}`;
    const res = await request.get(url);
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toContain("no-store");

    await page.goto(url);
    await expect(page.getByRole("button", { name: button })).toBeVisible();
    await expect(page.locator("form")).toHaveAttribute("method", "post");
    await expect(page.locator("form")).toHaveAttribute("action", `/api/access/${kind}`);
  });

  test(`/access/${kind} without a token shows no form`, async ({ page }) => {
    const response = await page.goto(`/access/${kind}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByText(/this link is no longer valid/i)).toBeVisible();
    await expect(page.locator("form")).toHaveCount(0);
  });
}
