import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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
import { CSV_COLUMN_COUNT, CSV_COLUMNS, CSV_COLUMN_NOTES } from "@/lib/dataset-csv";
import { SAMPLE_FACILITY_IDS } from "@/lib/dataset-offer";
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

const sample = (id: string, facilityType: string) => ({
  id,
  name: `Name of ${id}`,
  facilityType,
  operator: "Op",
  status: "operational",
  confidence: "confirmed",
  location: { state: "TX", lat: 1, lon: 2, precision: "exact" },
  statusHistory: [],
  sources: [{ url: "https://example.com/a", label: "A", retrievedAt: "2026-01-01", kind: "other" }],
  lastUpdated: "2026-01-01",
});
const SAMPLE_TYPES = ["data_center", "crypto_mining", "power_generation"];
const sampleFacilities = () => SAMPLE_FACILITY_IDS.map((id, i) => sample(id, SAMPLE_TYPES[i]!));

function openPage() {
  vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
  vi.stubEnv("DATASET_SHARING_ENABLED", "true");
}

beforeEach(() => {
  // The count's date is the moment it was taken; pin it so every assertion can name the exact date.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T01:04:00Z"));
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
  vi.useRealTimers();
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

  it("dates the live count and separates it from the edition's record count", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T01:04:00Z"));
    try {
      vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
      vi.stubEnv("DATASET_SHARING_ENABLED", "true");
      await renderPage();
      expect(document.body.textContent).toContain(
        "Latest edition (10 November 2026): 2 records. The live site has 2 facilities, counted on 12 November 2026.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses US spelling for the license statement", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage();
    expect(document.body.textContent).toContain("The fee is not a license fee.");
    expect(document.body.textContent).not.toContain("licence");
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

  it("gives every field an accessible label and the plan radios a named group", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage();
    for (const label of ["Email", "Name", "Organization"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByLabelText(/I agree to the terms/)).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "Plan" });
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
  });

  it("selects the annual plan when its card text is clicked", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage();
    expect(screen.getByRole("radio", { name: /\$1,500\/year/ })).not.toBeChecked();
    await userEvent.click(screen.getByText("$1,500/year"));
    expect(screen.getByRole("radio", { name: /\$1,500\/year/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /\$150\/month/ })).not.toBeChecked();
  });

  it("shows the buyer value with live numbers, the edition strip and file sizes", async () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    await renderPage();
    const text = document.body.textContent ?? "";
    expect(text).toContain("US data centers, crypto-mining sites and power plants");
    expect(text).toContain("Latest edition (10 November 2026): 2 records. The live site has 2 facilities, counted on 12 November 2026.");
    expect(text).toContain("Since the previous edition: 33 added, 43 updated, 0 removed.");
    expect(text.match(/Latest edition/g)).toHaveLength(1);
    expect(text).toContain("(9.1 MB)");
    expect(text).toContain(`the same records as a ${CSV_COLUMN_COUNT}-column table, ready for a spreadsheet (1.8 MB)`);
    expect(text).toContain("reading 5 of them (counted 12 November 2026)");
    expect(text).toContain("A new edition every Friday, and an email when it is ready");
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toEqual([
      "What you get",
      "See what's in it",
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
    expect(text).toContain("Latest edition (7 November 2026): 3,121 records. The live site has 2 facilities, counted on 12 November 2026.");
    expect(text).not.toContain("Latest edition 7 November 2026");
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

describe("/access/commercial dataset preview", () => {
  it("lists every CSV column with a meaning", async () => {
    openPage();
    await renderPage();
    const section = screen.getByRole("region", { name: "See what's in it" });
    const terms = section.querySelectorAll("dt");
    expect(terms).toHaveLength(CSV_COLUMN_COUNT);
    expect(terms[0]).toHaveTextContent("id");
    expect(terms[terms.length - 1]).toHaveTextContent(CSV_COLUMNS[CSV_COLUMNS.length - 1]);
    expect(terms[terms.length - 1]).toHaveTextContent("construction.receivingWater.segment");
    const defs = [...section.querySelectorAll("dd")].map((d) => d.textContent);
    expect(defs[0]).toBe(CSV_COLUMN_NOTES.id);
    const miningIndex = CSV_COLUMNS.indexOf("mining.hashRateThPerS");
    expect(defs[miningIndex]).toBe(CSV_COLUMN_NOTES["mining.hashRateThPerS"]);
    expect(defs[miningIndex]).toMatch(/TH\/s/);
  });

  it("shows the three fixed samples as JSON and CSV, each scroll region focusable and named", async () => {
    openPage();
    mocks.getAllFacilities.mockResolvedValue([...sampleFacilities(), fac("data_center", "OH", 1)]);
    await renderPage();
    for (const id of SAMPLE_FACILITY_IDS) {
      const pre = screen.getByLabelText(`Name of ${id} as JSON`);
      expect(pre).toHaveAttribute("tabindex", "0");
      expect(pre.textContent).toContain(`"id": "${id}"`);
    }
    const csv = screen.getByLabelText("Sample records as CSV");
    expect(csv).toHaveAttribute("tabindex", "0");
    expect(csv.textContent?.trim().split("\r\n")).toHaveLength(4);
    expect(screen.getByText("Name of riot-platforms-corsicana-tx (crypto-mining site)")).toBeInTheDocument();
  });

  it("renders the parsed record, so a key the schema does not know never reaches the page", async () => {
    openPage();
    const extra = { ...sampleFacilities()[0]!, internalOnlyKey: "leak-canary" };
    mocks.getAllFacilities.mockResolvedValue([extra]);
    await renderPage();
    const pre = screen.getByLabelText(`Name of ${SAMPLE_FACILITY_IDS[0]} as JSON`);
    expect(pre.textContent).not.toContain("leak-canary");
    expect(pre.textContent).toContain('"statusHistory": []');
  });

  it("skips a sample that fails schema validation", async () => {
    openPage();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getAllFacilities.mockResolvedValue([{ ...sampleFacilities()[0]!, status: "bogus" }]);
    await renderPage();
    expect(screen.queryByRole("heading", { name: "Sample records" })).toBeNull();
  });

  it("skips sample ids that are not in the dataset", async () => {
    openPage();
    mocks.getAllFacilities.mockResolvedValue([sample(SAMPLE_FACILITY_IDS[1]!, "crypto_mining")]);
    await renderPage();
    expect(screen.getAllByLabelText(/ as JSON$/)).toHaveLength(1);
  });

  it("renders exactly the samples present, without a count in the copy", async () => {
    openPage();
    mocks.getAllFacilities.mockResolvedValue(sampleFacilities().slice(0, 2));
    await renderPage();
    const section = screen.getByRole("region", { name: "See what's in it" });
    const heading = within(section).getByRole("heading", { name: "Sample records" });
    const block = heading.parentElement!;
    // two record <details> plus the CSV <details>
    expect(block.querySelectorAll("details")).toHaveLength(3);
    expect(within(block).getAllByLabelText(/ as JSON$/)).toHaveLength(2);
    expect(block.textContent).not.toMatch(/Three/);
  });

  it("omits the samples when none are present or the read fails", async () => {
    openPage();
    await renderPage();
    expect(screen.queryByRole("heading", { name: "Sample records" })).toBeNull();
    expect(screen.getByRole("heading", { name: /CSV columns/ })).toBeInTheDocument();
    document.body.innerHTML = "";
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getAllFacilities.mockRejectedValue(new Error("boom"));
    await renderPage();
    expect(screen.queryByRole("heading", { name: "Sample records" })).toBeNull();
    expect(screen.getByRole("button", { name: "Continue to PayPal" })).toBeInTheDocument();
  });

  it("cannot be steered by search params", async () => {
    openPage();
    mocks.getAllFacilities.mockResolvedValue([...sampleFacilities(), sample("other-record", "data_center")]);
    await renderPage({ id: "other-record", ids: "other-record", sample: "other-record", facility: "other-record" });
    expect(screen.queryByLabelText("Name of other-record as JSON")).toBeNull();
    expect(screen.getAllByLabelText(/ as JSON$/)).toHaveLength(3);
  });

  it("shows no headlines and says so for the initial edition", async () => {
    openPage();
    mocks.latestPublishedEdition.mockResolvedValue({
      id: "e1",
      editionDate: "2026-11-10",
      builtAt: new Date(),
      recordCount: 2,
      files: [],
      changelogSummary: { added: 0, updated: 0, removed: 0, headlines: ["Initial edition: 2 records"] },
    });
    await renderPage();
    expect(screen.getByText(/latest edition is the first/)).toBeInTheDocument();
    expect(screen.queryByText("Initial edition: 2 records")).toBeNull();
  });

  it("lists the real headlines of a later edition", async () => {
    openPage();
    mocks.latestPublishedEdition.mockResolvedValue({
      id: "e2",
      editionDate: "2026-11-17",
      builtAt: new Date(),
      recordCount: 2,
      files: [],
      changelogSummary: { added: 1, updated: 0, removed: 0, headlines: ["Added: Campus Alpha (TX)"] },
    });
    await renderPage();
    expect(screen.getByText("Added: Campus Alpha (TX)")).toBeInTheDocument();
    expect(screen.getByText(/Headlines from the edition of 17 November 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/latest edition is the first/)).toBeNull();
  });
});
