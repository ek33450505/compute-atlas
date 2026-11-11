import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const mocks = vi.hoisted(() => ({ getAllFacilities: vi.fn(), latestPublishedEdition: vi.fn() }));
vi.mock("@/lib/data", () => ({ getAllFacilities: mocks.getAllFacilities }));
vi.mock("@/lib/dataset-editions", () => ({ latestPublishedEdition: mocks.latestPublishedEdition }));

import CommercialPage, { generateMetadata } from "./page";
import { CSV_COLUMN_COUNT } from "@/lib/dataset-csv";
import SuccessPage, { dynamic, metadata } from "./success/page";

const NOINDEX = { index: false, follow: false };

async function renderPage(search: Record<string, string> = {}) {
  render(await CommercialPage({ searchParams: Promise.resolve(search) }));
}

const fac = (facilityType: string, state: string, sources: number) => ({
  facilityType,
  operator: `op-${state}`,
  location: { state },
  sources: Array.from({ length: sources }, () => ({})),
});

beforeEach(() => {
  mocks.getAllFacilities.mockResolvedValue([fac("data_center", "TX", 3), fac("crypto_mining", "OH", 2)]);
  mocks.latestPublishedEdition.mockResolvedValue({
    id: "e1",
    editionDate: "2026-11-10",
    builtAt: new Date(),
    recordCount: 2,
    files: [
      { name: "facilities.json", bytes: 9_084_324, pathname: "", sha256: "" },
      { name: "facilities.csv", bytes: 1_754_755, pathname: "", sha256: "" },
    ],
    changelogSummary: { added: 33, updated: 43, removed: 0, headlines: [] },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mocks.getAllFacilities.mockReset();
  mocks.latestPublishedEdition.mockReset();
});

describe("/access/commercial", () => {
  it("renders both plans with prices from COMMERCIAL_PLANS", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage();
    expect(
      screen.getByRole("heading", { level: 1, name: "The full dataset, every week" })
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
    expect(screen.getAllByText(/plus applicable tax/)).toHaveLength(3);
    expect(screen.getByText(/One named person per subscription/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "contact us" })).toHaveAttribute("href", "/contact");
    expect(
      screen.getByText(/Cancel anytime from your PayPal account; access runs to the end of the paid period\. No refunds for partial periods, except where the law requires one\./)
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
    expect(screen.getByText("You'll finish on PayPal.")).toBeInTheDocument();
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
      screen.getByText("One personal download link, sent by email as soon as payment completes")
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The data is CC BY 4\.0 for everyone: reuse it, including commercially, with attribution\./)
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /\$1,500\/year.*plus applicable tax/ })).toBeInTheDocument();
    expect(screen.queryByText(/months free/)).toBeNull();
  });

  it("shows the buyer value with live numbers, the edition strip and file sizes", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage();
    const text = document.body.textContent ?? "";
    expect(text).toContain("2 US data centers, crypto-mining sites and power plants");
    expect(text).toContain("Latest edition 10 November 2026 · 2 records · 33 added · 43 updated · 0 removed");
    expect(text).toContain("(9.1 MB)");
    expect(text).toContain(`the same records as a ${CSV_COLUMN_COUNT}-column table, ready for a spreadsheet (1.8 MB)`);
    expect(text).toContain("reading 5 of them");
    expect(text).toContain("A new edition every Friday, and an email when it is ready");
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      "What you get",
      "Who uses it",
      "Plans",
      "Compared with assembling it yourself",
      "Terms in plain words",
    ]);
    expect(screen.getByRole("link", { name: "table" })).toHaveAttribute("href", "/table");
    expect(text).toContain("the free table and facility pages may be all you need.");
    expect(text).toContain("siting-context.json: nearest water and transmission, basin water stress and aquifer, per facility");
    expect(text).not.toMatch(/months free|What is included/);
  });

  it("shows only the date and record count for the initial edition", async () => {
    mocks.latestPublishedEdition.mockResolvedValue({
      id: "e0",
      editionDate: "2026-11-07",
      builtAt: new Date(),
      recordCount: 3121,
      files: [],
      changelogSummary: { added: 0, updated: 0, removed: 0, headlines: ["Initial edition: 3121 records"] },
    });
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Latest edition 7 November 2026 · 3,121 records");
    expect(text).not.toMatch(/\d (added|updated|removed)/);
  });

  it.each([
    ["throws", () => mocks.latestPublishedEdition.mockRejectedValue(new Error("db down"))],
    ["returns null", () => mocks.latestPublishedEdition.mockResolvedValue(null)],
  ])("renders without the edition strip or file sizes when the edition read %s", async (_label, arrange) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    arrange();
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Latest edition");
    expect(text).not.toMatch(/\d MB\)/);
    expect(screen.getByRole("button", { name: "Continue to PayPal" })).toBeInTheDocument();
  });

  it("still renders the page when the facility read throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getAllFacilities.mockRejectedValue(new Error("db down"));
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "The full dataset, every week" })).toBeInTheDocument();
    expect(document.body.textContent).toContain("reading thousands of them");
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
