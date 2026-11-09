import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { mockGrant, mockEdition, mockFlag } = vi.hoisted(() => ({
  mockGrant: vi.fn(),
  mockEdition: vi.fn(),
  mockFlag: vi.fn(),
}));

vi.mock("@/lib/dataset-grants", () => ({ getGrantByAccessToken: mockGrant }));
vi.mock("@/lib/dataset-editions", () => ({ latestPublishedEdition: mockEdition }));
vi.mock("@/lib/dataset-flag", () => ({ isDatasetSharingEnabled: mockFlag }));

import AccessDatasetPage, { dynamic, metadata } from "./page";

const TOKEN = "Zk3_-" + "A".repeat(38); // 43 chars, includes URL-significant characters
const GRANT = {
  state: "active" as const,
  grant: { id: "g1", name: "Pat Reporter", organization: "Daily Planet", expiresAt: new Date("2027-06-15T12:00:00Z") },
};
const EDITION = {
  id: "e1",
  editionDate: "2026-11-07",
  builtAt: new Date("2026-11-07T14:00:00Z"),
  recordCount: 2345,
  files: [
    { name: "facilities.json", pathname: "p/f.json", bytes: 2_621_440, sha256: "deadbeef".repeat(8) },
    { name: "facilities.csv", pathname: "p/f.csv", bytes: 512, sha256: "cafebabe".repeat(8) },
    { name: "siting-context.json", pathname: "p/s.json", bytes: 90_000, sha256: "0".repeat(64) },
    { name: "changelog.json", pathname: "p/c.json", bytes: 1500, sha256: "1".repeat(64) },
    { name: "README.txt", pathname: "p/r.txt", bytes: 4096, sha256: "2".repeat(64) },
  ],
  changelogSummary: { added: 12, updated: 30, removed: 1, headlines: ["Added Acme Campus (OH)", "<img src=x onerror=alert(1)>"] },
};

async function renderPage(search: { t?: string | string[] } = { t: TOKEN }) {
  return render(await AccessDatasetPage({ searchParams: Promise.resolve(search) }));
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  mockFlag.mockReturnValue(true);
  mockGrant.mockResolvedValue({ state: "inactive" });
  mockEdition.mockResolvedValue(null);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("/access/dataset route config", () => {
  it("is force-dynamic, noindex and sends no referrer", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe("no-referrer");
  });
});

describe("/access/dataset flag off", () => {
  it("renders the not-open copy and never looks the token up", async () => {
    mockFlag.mockReturnValue(false);
    await renderPage();
    expect(screen.getByText(/not open yet/i)).toBeInTheDocument();
    expect(mockGrant).not.toHaveBeenCalled();
  });
});

describe("/access/dataset invalid links", () => {
  it("renders one generic page for a missing token, an array token, an inactive grant and a DB failure", async () => {
    const htmls: string[] = [];

    htmls.push((await renderPage({})).container.innerHTML);
    expect(mockGrant).not.toHaveBeenCalled();

    htmls.push((await renderPage({ t: [TOKEN, TOKEN] })).container.innerHTML);
    expect(mockGrant).not.toHaveBeenCalled();

    mockGrant.mockResolvedValue(GRANT); // even a lookup that would succeed must not be reached
    htmls.push((await renderPage({ t: "" })).container.innerHTML);
    expect(mockGrant).not.toHaveBeenCalled();

    mockGrant.mockResolvedValue({ state: "inactive" });
    htmls.push((await renderPage({ t: TOKEN })).container.innerHTML);
    expect(mockGrant).toHaveBeenCalledWith(TOKEN);

    mockGrant.mockRejectedValue(new Error(`Failed query: select ... params: ${TOKEN}`));
    htmls.push((await renderPage({ t: TOKEN })).container.innerHTML);

    expect(new Set(htmls).size).toBe(1);
    expect(htmls[0]).not.toContain(TOKEN);
  });

  it("says the link isn't active and points to /access and /contact", async () => {
    await renderPage({});
    expect(screen.getByRole("heading", { level: 1, name: "Link not active" })).toBeInTheDocument();
    expect(screen.getByText("This link isn't active.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /dataset access page/i })).toHaveAttribute("href", "/access");
    expect(screen.getByRole("link", { name: /contact page/i })).toHaveAttribute("href", "/contact");
  });

  it("logs only a redacted code when the lookup throws, never the token or the error text", async () => {
    mockGrant.mockRejectedValue(
      Object.assign(new Error(`Failed query: ... params: ${TOKEN}`), { code: "08006" })
    );
    await renderPage({ t: TOKEN });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("08006");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("Failed query");
  });

  it("falls back to the generic page when the edition read throws", async () => {
    mockGrant.mockResolvedValue(GRANT);
    mockEdition.mockRejectedValue(Object.assign(new Error("boom"), { code: "57P01" }));
    await renderPage();
    expect(screen.getByText("This link isn't active.")).toBeInTheDocument();
    expect(screen.queryByText(/prepared for/i)).not.toBeInTheDocument();
  });
});

describe("/access/dataset active grant, no edition yet", () => {
  it("explains the first edition is pending, with no file links", async () => {
    mockGrant.mockResolvedValue(GRANT);
    mockEdition.mockResolvedValue(null);
    await renderPage();

    expect(screen.getByText(/no edition has been published yet/i)).toBeInTheDocument();
    expect(screen.getByText(/built on saturday; this link will work then/i)).toBeInTheDocument();
    expect(screen.getByText("Prepared for Pat Reporter, Daily Planet")).toBeInTheDocument();
    expect(screen.queryAllByRole("link", { name: /\.(json|csv|txt)$/ })).toHaveLength(0);
  });
});

describe("/access/dataset active grant with an edition", () => {
  beforeEach(() => {
    mockGrant.mockResolvedValue(GRANT);
    mockEdition.mockResolvedValue(EDITION);
  });

  it("heads with the edition date and shows who it is prepared for and the record count", async () => {
    await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Edition of November 7, 2026" })).toBeInTheDocument();
    expect(screen.getByText("Prepared for Pat Reporter, Daily Planet")).toBeInTheDocument();
    expect(screen.getByText(/2,345 records/)).toBeInTheDocument();
  });

  it("omits the organization when there is none", async () => {
    mockGrant.mockResolvedValue({ ...GRANT, grant: { ...GRANT.grant, organization: null } });
    await renderPage();
    expect(screen.getByText("Prepared for Pat Reporter")).toBeInTheDocument();
  });

  it("links the five files in order, with the encoded token, rel=noreferrer and sizes", async () => {
    await renderPage();
    const files = screen.getByRole("region", { name: "Files" });
    const links = within(files).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual([
      "facilities.json",
      "facilities.csv",
      "siting-context.json",
      "changelog.json",
      "README.txt",
    ]);
    const names = ["facilities.json", "facilities.csv", "siting-context.json", "changelog.json", "README.txt"];
    links.forEach((a, i) => {
      expect(a).toHaveAttribute("href", `/api/dataset/file?t=${encodeURIComponent(TOKEN)}&f=${names[i]}`);
      expect(a).toHaveAttribute("rel", "noreferrer");
    });
    expect(within(files).getByText("(2.5 MB)")).toBeInTheDocument();
    expect(within(files).getByText("(512 B)")).toBeInTheDocument();
    expect(within(files).getByText("(87.9 KB)")).toBeInTheDocument();
  });

  it("encodes a token with URL-significant characters in the href", async () => {
    const odd = "a&b=c d#e" + "x".repeat(10);
    await renderPage({ t: odd });
    const first = within(screen.getByRole("region", { name: "Files" })).getAllByRole("link")[0];
    expect(first.getAttribute("href")).toBe(`/api/dataset/file?t=${encodeURIComponent(odd)}&f=facilities.json`);
    expect(first.getAttribute("href")).not.toContain("a&b=c");
  });

  it("shows the token nowhere outside the file hrefs", async () => {
    const { container } = await renderPage();
    const stripped = container.innerHTML.split(`t=${encodeURIComponent(TOKEN)}`).join("");
    expect(stripped).not.toContain(TOKEN);
    expect(container.textContent).not.toContain(TOKEN);
  });

  it("renders the changelog counts and headlines as inert plain text", async () => {
    const { container } = await renderPage();
    const section = screen.getByRole("region", { name: "What changed" });
    expect(within(section).getByText(/12 added, 30 updated, 1 removed/)).toBeInTheDocument();
    expect(within(section).getByText("Added Acme Campus (OH)")).toBeInTheDocument();
    expect(within(section).getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("caps headlines at 10 and tolerates a malformed summary", async () => {
    mockEdition.mockResolvedValue({
      ...EDITION,
      changelogSummary: { added: "many", headlines: Array.from({ length: 15 }, (_, i) => `h${i}`).concat([42 as never]) },
    });
    await renderPage();
    const section = screen.getByRole("region", { name: "What changed" });
    expect(within(section).getAllByRole("listitem")).toHaveLength(10);
    expect(within(section).queryByText(/Since the previous edition/)).not.toBeInTheDocument();

    mockEdition.mockResolvedValue({ ...EDITION, changelogSummary: "nonsense" });
    document.body.innerHTML = "";
    await renderPage();
    expect(screen.queryByRole("region", { name: "What changed" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Files" })).getAllByRole("link")).toHaveLength(5);
  });

  it("states the CC BY 4.0 attribution, the expiry date and the watermark note", async () => {
    await renderPage();
    expect(
      screen.getByText(
        "Data from Compute Atlas by Edward Kubiak (https://www.compute-atlas.com), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)."
      )
    ).toBeInTheDocument();
    const time = screen.getByText("June 15, 2027");
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("datetime", "2027-06-15T12:00:00.000Z");
    expect(screen.getByText(/recipient-specific identifiers/i)).toBeInTheDocument();
  });

  it("never shows checksums", async () => {
    const { container } = await renderPage();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/sha-?256|checksum/i);
    expect(text).not.toContain("deadbeef");
  });

  it("uses h1 then h2 headings only", async () => {
    await renderPage();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 2 }).length).toBeGreaterThanOrEqual(3);
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
  });
});
