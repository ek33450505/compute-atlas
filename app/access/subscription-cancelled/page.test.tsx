import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { mockFlag } = vi.hoisted(() => ({ mockFlag: vi.fn() }));
vi.mock("@/lib/dataset-flag", () => ({ isDatasetSharingEnabled: mockFlag }));

import SubscriptionCancelledPage, { metadata } from "./page";

async function renderPage(search: { status?: string | string[] }) {
  return render(await SubscriptionCancelledPage({ searchParams: Promise.resolve(search) }));
}

beforeEach(() => {
  mockFlag.mockReturnValue(true);
});

describe("/access/subscription-cancelled", () => {
  it("is noindex", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("shows the not-open copy with the flag off", async () => {
    mockFlag.mockReturnValue(false);
    await renderPage({ status: "cancelled" });
    expect(screen.getByText(/not open yet/i)).toBeInTheDocument();
  });

  it("confirms the cancellation with fixed copy and no date", async () => {
    await renderPage({ status: "cancelled" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Your subscription is cancelled. Your access continues until the end of the period you've already paid for; the date is shown on your download page."
    );
  });

  it("renders nothing from a crafted query beyond the two fixed outcomes", async () => {
    const { container } = render(
      await SubscriptionCancelledPage({
        searchParams: Promise.resolve({ status: "cancelled", through: "2099-01-01" } as { status: string }),
      })
    );
    expect(container.textContent).not.toContain("2099");
  });

  it.each([[undefined], ["error"], ["anything"]])("shows the one generic failure for status=%s", async (status) => {
    await renderPage({ status });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "We couldn't cancel right now. Please try again, or cancel in your PayPal account."
    );
  });
});
