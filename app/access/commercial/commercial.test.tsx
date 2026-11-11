import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

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
    expect(screen.getByRole("radio", { name: /\$150\/month/ })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /\$1,500\/year/ })).toBeInTheDocument();
    expect(screen.queryByText(/months free/)).toBeNull();
    expect(screen.getByText(/never sees your payment details/i)).toBeInTheDocument();
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
      screen.getByText(/Cancel anytime from your PayPal account; access runs to the end of the paid period\. No refunds for partial periods\./)
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Commercial access terms" })).toHaveAttribute("href", "/access/terms");
  });

  it("renders one native form posting plan, details and terms to the checkout route", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage();
    const submit = screen.getByRole("button", { name: "Continue to PayPal" });
    const form = submit.closest("form")!;
    expect(document.querySelectorAll("form")).toHaveLength(1);
    expect(form).toHaveAttribute("method", "post");
    expect(form).toHaveAttribute("action", "/api/access/checkout");
    const group = screen.getByRole("group", { name: "Plan" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(["monthly", "annual"]);
    expect(radios.every((r) => r.hasAttribute("required") && r.getAttribute("name") === "plan")).toBe(true);
    expect(screen.getByRole("radio", { name: /\$150\/month/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /\$1,500\/year/ })).not.toBeChecked();
    for (const [label, name, autocomplete] of [
      ["Email", "email", "email"],
      ["Name", "name", "name"],
      ["Organization", "organization", "organization"],
    ] as const) {
      const input = screen.getByLabelText(label);
      expect(input).toBeRequired();
      expect(input).toHaveAttribute("name", name);
      expect(input).toHaveAttribute("autocomplete", autocomplete);
    }
    const terms = screen.getByRole("checkbox", { name: /I agree to the terms/ });
    expect(terms).toBeRequired();
    expect(terms).toHaveAttribute("name", "acceptTerms");
    expect(within(form).getByRole("link", { name: "terms" })).toHaveAttribute("href", "/access/terms");
    expect(screen.getByText(/finish on PayPal; a PayPal account is required/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/stripe/i);
  });

  it.each([
    ["plan", /plan was not recognized/i],
    ["busy", /checkout is busy right now/i],
    ["unavailable", /temporarily unavailable/i],
    ["details", /check your details.*unsupported characters/i],
    ["terms", /agree to the terms/i],
    ["request", /couldn't be processed/i],
  ])("shows an alert for ?error=%s", async (error, text) => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage({ error });
    expect(screen.getByRole("alert")).toHaveTextContent(text);
  });

  it("points the form's aria-describedby at the alert only when an error shows", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage({ error: "details" });
    const form = screen.getByRole("button", { name: "Continue to PayPal" }).closest("form")!;
    expect(form).toHaveAccessibleDescription(/check your details/i);
    expect(screen.getByRole("alert")).toHaveAttribute("id", form.getAttribute("aria-describedby"));
  });

  it("has no aria-describedby on the form without an error", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage();
    const form = screen.getByRole("button", { name: "Continue to PayPal" }).closest("form")!;
    expect(form).not.toHaveAttribute("aria-describedby");
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
      expect(screen.getByRole("button", { name: "Continue to PayPal" })).toBeInTheDocument();
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
    expect(screen.getByRole("radio", { name: /\$1,500\/year.*plus applicable tax/ })).toBeInTheDocument();
    expect(screen.queryByText(/months free/)).toBeNull();
  });

  it.each(["cancelled", "canceled"])("shows the cancelled note for ?%s=1", async (key) => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage({ [key]: "1" });
    expect(screen.getByText("Checkout was cancelled; nothing was charged.")).toBeInTheDocument();
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
    expect(screen.getByRole("heading", { level: 1, name: "Thank you" })).toBeInTheDocument();
    expect(
      screen.getByText(/When PayPal confirms your subscription, we'll email your personal download link to the address you entered\. This usually takes a minute\./)
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/stripe/i);
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
