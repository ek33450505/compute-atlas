import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import CommercialPage, { generateMetadata } from "./page";
import SuccessPage, { dynamic, metadata } from "./success/page";

const NOINDEX = { index: false, follow: false };

async function renderPage(search: Record<string, string> = {}) {
  render(await CommercialPage({ searchParams: Promise.resolve(search) }));
}

afterEach(() => vi.unstubAllEnvs());

describe("/access/commercial", () => {
  it("renders both plans with prices from COMMERCIAL_PLANS", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    await renderPage();
    expect(
      screen.getByRole("heading", { level: 1, name: "Commercial access to the dataset" })
    ).toBeInTheDocument();
    expect(screen.getByText("$150/month")).toBeInTheDocument();
    expect(screen.getByText("$1,500/year")).toBeInTheDocument();
    expect(screen.getByText(/2 months free/)).toBeInTheDocument();
    expect(screen.getByText(/never sees card details/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "dataset access" })).toHaveAttribute("href", "/access");
  });

  it("posts each plan to the checkout route", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    await renderPage();
    for (const [name, plan] of [
      ["Subscribe monthly", "monthly"],
      ["Subscribe annually", "annual"],
    ] as const) {
      const form = screen.getByRole("button", { name }).closest("form")!;
      expect(form).toHaveAttribute("method", "post");
      expect(form).toHaveAttribute("action", "/api/access/checkout");
      expect(form.querySelector('input[name="plan"]')).toHaveValue(plan);
    }
  });

  it.each([
    ["plan", /plan was not recognized/i],
    ["busy", /too many checkout attempts/i],
    ["unavailable", /temporarily unavailable/i],
  ])("shows an alert for ?error=%s", async (error, text) => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    await renderPage({ error });
    expect(screen.getByRole("alert")).toHaveTextContent(text);
  });

  it("ignores an unknown error value", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    await renderPage({ error: "<script>" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["__proto__", "constructor", "toString", "nope"])(
    "shows no banner and does not crash for ?error=%s",
    async (error) => {
      vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
      await renderPage({ error });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Subscribe monthly" })).toBeInTheDocument();
    }
  );

  it("renders seats and the annual note from the shared constants", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    await renderPage();
    expect(screen.getByText(/up to 3 people/)).toBeInTheDocument();
    expect(screen.getByText(/2 months free\./)).toBeInTheDocument();
  });

  it("shows the canceled note for ?canceled=1", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    await renderPage({ canceled: "1" });
    expect(screen.getByText("Checkout was canceled; nothing was charged.")).toBeInTheDocument();
  });

  it("is indexable with a canonical when on", () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    const meta = generateMetadata();
    expect(meta.alternates?.canonical).toBe("/access/commercial");
    expect(meta.robots).toBeUndefined();
  });

  it("renders not-open and noindex when off", async () => {
    await renderPage();
    expect(screen.getByText(/not open yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(generateMetadata().robots).toEqual(NOINDEX);
  });
});

describe("/access/commercial/success", () => {
  it("renders without session data, noindex and dynamic", () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    render(<SuccessPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Payment received" })).toBeInTheDocument();
    expect(screen.getByText(/within a few minutes/i)).toBeInTheDocument();
    expect(screen.getByText(/spam/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "contact page" })).toHaveAttribute("href", "/contact");
    expect(metadata.robots).toEqual(NOINDEX);
    expect(dynamic).toBe("force-dynamic");
  });

  it("renders not-open when off", () => {
    render(<SuccessPage />);
    expect(screen.getByText(/not open yet/i)).toBeInTheDocument();
  });
});
