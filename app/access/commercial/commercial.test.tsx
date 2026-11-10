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
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage();
    expect(
      screen.getByRole("heading", { level: 1, name: "Commercial access to the dataset" })
    ).toBeInTheDocument();
    expect(screen.getByText("$150/month")).toBeInTheDocument();
    expect(screen.getByText("$1,500/year")).toBeInTheDocument();
    expect(screen.queryByText(/months free/)).toBeNull();
    expect(screen.getByText(/never sees card details/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "dataset access" })).toHaveAttribute("href", "/access");
  });

  it("states tax, cancellation, refund terms and links the terms and contact pages", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage();
    expect(screen.getAllByText(/plus applicable tax/)).toHaveLength(2);
    expect(screen.getByText(/Need access for a team\?/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Contact us" })).toHaveAttribute("href", "/contact");
    expect(
      screen.getByText(/Cancel anytime from Manage billing; access runs to the end of the paid period\. No refunds for partial periods\./)
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Commercial access terms" })).toHaveAttribute("href", "/access/terms");
  });

  it("posts each plan to the checkout route", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
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
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage({ error });
    expect(screen.getByRole("alert")).toHaveTextContent(text);
  });

  it("ignores an unknown error value", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage({ error: "<script>" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["__proto__", "constructor", "toString", "nope"])(
    "shows no banner and does not crash for ?error=%s",
    async (error) => {
      vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
      vi.stubEnv("DATASET_SHARING_ENABLED", "true");
      await renderPage({ error });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Subscribe monthly" })).toBeInTheDocument();
    }
  );

  it("renders the one-person line and the annual price with no free-months label", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage();
    expect(
      screen.getByText("One personal download link per subscription, sent by email after payment")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("A personal download link, sent by email after payment")
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/The data is CC BY 4\.0 for everyone, and a subscription does not change that\./)
    ).toBeInTheDocument();
    const annualForm = screen.getByRole("button", { name: "Subscribe annually" }).closest("form")!;
    expect(annualForm).toHaveTextContent("$1,500/year · plus applicable tax.");
    expect(annualForm).not.toHaveTextContent(/months free/);
    expect(screen.queryByText(/months free/)).toBeNull();
  });

  it("shows the canceled note for ?canceled=1", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage({ canceled: "1" });
    expect(screen.getByText("Checkout was canceled; nothing was charged.")).toBeInTheDocument();
  });

  it("is indexable with a canonical when on", () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    const meta = generateMetadata();
    expect(meta.alternates?.canonical).toBe("/access/commercial");
    expect(meta.robots).toBeUndefined();
  });

  it("renders not-open when the tier is on but dataset sharing is off", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "");
    await renderPage();
    expect(screen.getByText(/not open yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders not-open and noindex when off", async () => {
    await renderPage();
    expect(screen.getByText(/not open yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(generateMetadata().robots).toEqual(NOINDEX);
  });
});

describe("/access/commercial/success", () => {
  it("renders not-open when dataset sharing is off", () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "");
    render(<SuccessPage />);
    expect(screen.getByText(/not open yet/i)).toBeInTheDocument();
  });

  it("renders without session data, noindex and dynamic", () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
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
