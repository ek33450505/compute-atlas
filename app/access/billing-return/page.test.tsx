import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import BillingReturnPage, { dynamic, metadata } from "./page";

async function renderPage(search: { status?: string | string[] } = {}) {
  return render(await BillingReturnPage({ searchParams: Promise.resolve(search) }));
}

beforeEach(() => {
  vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
  vi.stubEnv("DATASET_SHARING_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("/access/billing-return", () => {
  it("is noindex and dynamic", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(dynamic).toBe("force-dynamic");
  });

  it("is neutral by default and does not claim billing was updated", async () => {
    const { container } = await renderPage();
    expect(screen.getByText("You're back from billing. Use the personal link from your email to return to your downloads.")).toBeTruthy();
    expect(container.textContent).not.toMatch(/billing updated/i);
  });

  it("says billing could not be opened for ?status=unavailable", async () => {
    await renderPage({ status: "unavailable" });
    expect(screen.getByText(/Billing could not be opened\. Use your personal link from your email to try again/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "contact page" }).getAttribute("href")).toBe("/contact");
  });

  it("treats any other status as the default", async () => {
    await renderPage({ status: "bogus" });
    expect(screen.getByText(/You're back from billing\./)).toBeTruthy();
  });

  it("shows the not-open page when dataset sharing is off", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "");
    await renderPage();
    expect(screen.getByText(/not open yet/)).toBeTruthy();
  });

  it("shows the not-open page with the flag off", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "");
    await renderPage();
    expect(screen.getByText(/not open yet/)).toBeTruthy();
  });
});
