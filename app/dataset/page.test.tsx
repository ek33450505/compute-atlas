import { vi, describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// next/link renders to <a> — mock to avoid Next.js router-context dependency in jsdom
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const mocks = vi.hoisted(() => ({ getAllFacilities: vi.fn(), latestPublishedEdition: vi.fn() }));
vi.mock("@/lib/data", () => ({ getAllFacilities: mocks.getAllFacilities, loadFacilities: mocks.getAllFacilities }));
vi.mock("@/lib/dataset-editions", () => ({ latestPublishedEdition: mocks.latestPublishedEdition }));

import DatasetPage, { generateMetadata } from "./page";
import { CSV_COLUMN_COUNT } from "@/lib/dataset-csv";
import { MAX_ROWS } from "@/lib/table-query";

const fac = (facilityType: string, state: string, operator: string, sources: number) => ({
  facilityType,
  operator,
  location: { state },
  sources: Array.from({ length: sources }, () => ({})),
});

beforeEach(() => {
  mocks.getAllFacilities.mockResolvedValue([
    fac("data_center", "TX", "Alpha", 3),
    fac("data_center", "VA", "Beta", 2),
    fac("crypto_mining", "OH", "Alpha", 1),
    fac("power_generation", "TX", "Gamma", 4),
  ]);
  mocks.latestPublishedEdition.mockResolvedValue({
    id: "e1",
    editionDate: "2026-11-10",
    builtAt: new Date(),
    recordCount: 4,
    files: [],
    changelogSummary: { added: 7, updated: 8, removed: 0, headlines: [] },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// The count's as-of date is the READ time. Only Date is faked so promises still settle.
function readAt(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

describe("DatasetPage", () => {
  const datasetNodes = () =>
    Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map((el) => JSON.parse(el.textContent ?? "{}"))
      .filter((n) => n["@type"] === "Dataset");

  it("emits one Dataset JSON-LD node, not free for everyone, when sharing is on", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    render(await DatasetPage());
    const nodes = datasetNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0].isAccessibleForFree).toBe(false);
    expect(nodes[0].url).toMatch(/\/dataset$/);
    expect(nodes[0].conditionsOfAccess).toContain("paid for commercial use");
  });

  it("uses the non-commercial conditionsOfAccess when the commercial tier is off", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "");
    render(await DatasetPage());
    expect(datasetNodes()[0].conditionsOfAccess).toBe(
      "Facility pages are free to read. Data files require approved access, free for students and educators.",
    );
  });

  it("emits no Dataset JSON-LD when sharing is off", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "");
    render(await DatasetPage());
    expect(datasetNodes()).toHaveLength(0);
  });

  it("shows the free card only, with no paid-tier section, when commercial is off", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "");
    render(await DatasetPage());
    expect(screen.getByRole("heading", { level: 3, name: "Free" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Request access" })).toHaveAttribute("href", "/access?from=data");
    expect(screen.queryByRole("heading", { name: "Commercial" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Why it costs money" })).not.toBeInTheDocument();
    expect(screen.queryByText(/\$150/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Preview the files and plans" })).not.toBeInTheDocument();
  });

  it("restricts the free tier to students and educators", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    render(await DatasetPage());
    const free = screen.getByRole("heading", { level: 3, name: "Free" }).closest("section")!;
    expect(free).toHaveTextContent("For students and educators");
    expect(document.body.textContent).not.toMatch(/academics/i);
    expect(free.textContent).not.toMatch(/government|journalist|nonprofit/i);
  });

  it("shows both cards and the why section when sharing and commercial are on", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    render(await DatasetPage());
    const card = screen.getByRole("heading", { level: 3, name: "Commercial" }).closest("section")!;
    expect(card).toHaveTextContent("$150/month or $1,500/year, plus applicable tax");
    expect(card).toHaveTextContent("For everyone else: companies, consultancies, investors, utilities, law firms, journalists, nonprofits and government.");
    expect(card).toHaveTextContent("One link per subscription; for a team, contact us.");
    expect(within(card).getByRole("link", { name: "Preview the files and plans" })).toHaveAttribute("href", "/access/commercial");
    expect(within(card).getByRole("link", { name: "contact us" })).toHaveAttribute("href", "/contact");
    expect(screen.getByRole("heading", { level: 2, name: "Why it costs money" })).toBeInTheDocument();
    expect(document.body.textContent).toContain("the fee pays for the work, not a license");
    expect(document.body.textContent).not.toMatch(/donat|support us|months free/i);
  });

  it("renders dated live counts, the edition-vs-live sentence, and the quoted constants", async () => {
    readAt("2026-11-12T01:04:00Z");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    render(await DatasetPage());
    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "Latest edition (10 November 2026): 4 records. The live site has 4 facilities, counted on 12 November 2026.",
    );
    expect(text).toContain("2 data centers · 1 crypto-mining sites · 1 power plants");
    // One jurisdiction wording site-wide (statesPhrase), not "states and territories".
    expect(text).toContain("3 states · 3 operators · 10 source links");
    expect(text).not.toContain("states and territories");
    expect(text).toContain("Since the previous edition: 7 added, 8 updated, 0 removed.");
    // One "Latest edition" statement, not two.
    expect(text.match(/Latest edition/g)).toHaveLength(1);
    expect(text).toContain(`the table stops at ${MAX_ROWS} rows`);
    expect(text).toContain(`${CSV_COLUMN_COUNT} CSV columns per facility`);
  });

  it("omits the change counts for the initial edition", async () => {
    mocks.latestPublishedEdition.mockResolvedValue({
      id: "e0",
      editionDate: "2026-11-07",
      builtAt: new Date(),
      recordCount: 3121,
      files: [],
      changelogSummary: { added: 0, updated: 0, removed: 0, headlines: ["Initial edition: 3121 records"] },
    });
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    render(await DatasetPage());
    const text = document.body.textContent ?? "";
    expect(text).toContain("Latest edition (7 November 2026): 3,121 records.");
    expect(text).not.toContain("Latest edition: 7 November 2026");
    expect(text).not.toMatch(/\d (added|updated|removed)/);
  });

  it("keeps zero counts on a later edition and omits a clause whose count is missing", async () => {
    mocks.latestPublishedEdition.mockResolvedValue({
      id: "e2",
      editionDate: "2026-11-14",
      builtAt: new Date(),
      recordCount: 10,
      files: [],
      changelogSummary: { added: 0, updated: 4, headlines: [] },
    });
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    render(await DatasetPage());
    const text = document.body.textContent ?? "";
    expect(text).toContain("Since the previous edition: 0 added, 4 updated.");
    expect(text).not.toMatch(/\d removed/);
  });

  it("words siting context without claiming it covers every facility", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    render(await DatasetPage());
    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "Siting context. Nearest surface water and ≥230 kV transmission line, basin water stress and aquifer, per facility, keyed by facility id.",
    );
    expect(text).not.toMatch(/Siting context, joined|aquifer for every facility/);
  });

  it.each([
    ["throws", () => mocks.latestPublishedEdition.mockRejectedValue(new Error("db down"))],
    ["returns null", () => mocks.latestPublishedEdition.mockResolvedValue(null)],
  ])("omits the edition line, keeping the page, when the edition read %s", async (_label, arrange) => {
    readAt("2026-11-12T01:04:00Z");
    vi.spyOn(console, "error").mockImplementation(() => {});
    arrange();
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    render(await DatasetPage());
    expect(document.body.textContent).not.toContain("Latest edition");
    expect(screen.getByRole("heading", { level: 2, name: "The full dataset" })).toBeInTheDocument();
    // No edition: the live count stands alone, still dated.
    expect(document.body.textContent).toContain("4 facilities, counted on 12 November 2026.");
    expect(document.body.textContent).not.toContain("The live site has");
  });

  it("omits the stat lines, keeping the page, when the facility read throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getAllFacilities.mockRejectedValue(new Error("db down"));
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    render(await DatasetPage());
    expect(document.body.textContent).not.toContain("source links");
    expect(document.body.textContent).not.toContain("facilities, counted on");
    // The edition's own count still stands; the live clause is omitted, not invented.
    expect(document.body.textContent).toContain("Latest edition (10 November 2026): 4 records.");
    expect(document.body.textContent).not.toContain("The live site has");
    expect(screen.getByRole("link", { name: "Request access" })).toBeInTheDocument();
  });

  it("reads no data at all when sharing is off", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "");
    render(await DatasetPage());
    expect(mocks.getAllFacilities).not.toHaveBeenCalled();
    expect(mocks.latestPublishedEdition).not.toHaveBeenCalled();
  });

  it("shows no cards when sharing is off, even if commercial is on, only a not-open notice", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "");
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    render(await DatasetPage());
    expect(screen.queryByRole("heading", { name: "Free" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Commercial" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Why it costs money" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "contact page" })).toHaveAttribute("href", "/contact");
    expect(screen.getByRole("link", { name: "Cite & license" })).toHaveAttribute("href", "/data");
  });

  it("does not mention Ko-fi", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    const { container } = render(await DatasetPage());
    expect(container.textContent ?? "").not.toMatch(/ko-?fi/i);
    expect(readSource("app/dataset/page.tsx")).not.toMatch(/ko-?fi/i);
  });

  it.each([["false"], [""]])("renders no request-access text when the flag is %j", async (value) => {
    vi.stubEnv("DATASET_SHARING_ENABLED", value);
    render(await DatasetPage());
    expect(screen.queryByText(/request access/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/full dataset/i)).not.toBeInTheDocument();
  });

  it.each([["true"], ["false"]])("keeps the forbidden-words and data-file-link guard when the flag is %s", async (value) => {
    vi.stubEnv("DATASET_SHARING_ENABLED", value);
    const { container } = render(await DatasetPage());
    expect(container.textContent ?? "").not.toMatch(/bulk|paused|programmatic|developer docs/i);
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => /facilities\.(csv|json)|^\/api/.test(h ?? ""))).toBe(false);
  });

  it("reads data only through the cached, fail-soft offer helper", () => {
    const src = readSource("app/dataset/page.tsx");
    expect(src).not.toMatch(/from "@\/lib\/data"|getAllFacilities\(|latestPublishedEdition\(/);
    expect(src).toMatch(/from "@\/lib\/dataset-offer"/);
  });

  it("keeps raw HTML entities out of metadata string props, which JSX does not decode", () => {
    for (const sharing of ["true", ""]) {
      vi.stubEnv("DATASET_SHARING_ENABLED", sharing);
      vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
      const m = generateMetadata();
      for (const v of [m.title, m.description]) {
        expect(typeof v).toBe("string");
        expect(v).not.toMatch(/&(mdash|ndash|rsquo|lsquo|middot|amp|nbsp);/);
      }
    }
  });

  it("does not advertise files in the metadata description while sharing is off", () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "");
    expect(generateMetadata().description).not.toMatch(/weekly|JSON|CSV|free for/i);
  });

  it("sets noindex only while sharing is off, with canonical /dataset", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "");
    const off = generateMetadata();
    expect(off.robots).toEqual({ index: false, follow: false });
    expect(off.alternates).toEqual({ canonical: "/dataset" });
    expect(off.title).toBe("Dataset");
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    expect(generateMetadata().robots).toBeUndefined();
  });

  it("describes the files, quoting the price only while the commercial tier is on", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    const on = generateMetadata().description ?? "";
    expect(on).toContain("$150/month for everyone else");
    expect(on.length).toBeLessThanOrEqual(160);
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "");
    expect(generateMetadata().description).not.toMatch(/\$/);
  });

  it("renders one h1, the ordered h2 sections, and a lone link to /data for citing", async () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    render(await DatasetPage());
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Dataset" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "The full dataset",
      "What the files hold",
      "Why it costs money",
    ]);
    expect(screen.getByRole("link", { name: "Cite & license" })).toHaveAttribute("href", "/data");
    expect(document.body.textContent).not.toMatch(/How to cite Compute Atlas/);
  });

  it("emits a Home > Dataset BreadcrumbList and declares revalidate = 86400", async () => {
    const { container } = render(await DatasetPage());
    const ld = JSON.parse(container.querySelector('script[type="application/ld+json"]')!.textContent!);
    expect(ld.itemListElement.map((i: { name: string }) => i.name)).toEqual(["Home", "Map", "Dataset"]);
    expect(ld.itemListElement[2].item).toBe("https://www.compute-atlas.com/dataset");
    expect(readSource("app/dataset/page.tsx")).toMatch(/^export const revalidate = 86400;$/m);
  });
});

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}
