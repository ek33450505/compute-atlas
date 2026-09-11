import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { ContributorCredit } from "@/lib/data";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mock
// through vi.hoisted() so its initialization is hoisted alongside the
// vi.mock call itself — mirrors app/operators/page.test.tsx.
const { mockGetContributorCredits } = vi.hoisted(() => ({
  mockGetContributorCredits: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getContributorCredits: mockGetContributorCredits,
}));

// next/link renders to <a> — mock to avoid Next.js router-context dependency
// in jsdom (same pattern as app/operators/page.test.tsx / app/support/page.test.tsx).
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

import ContributorsPage from "./page";

const CREDITS: ContributorCredit[] = [
  { attribution: "alice", count: 3 },
  { attribution: "bob", count: 1 },
];

beforeEach(() => {
  mockGetContributorCredits.mockReset();
});

describe("ContributorsPage — populated list", () => {
  beforeEach(() => {
    mockGetContributorCredits.mockResolvedValue(CREDITS);
  });

  it("renders the h1", async () => {
    const page = await ContributorsPage();
    render(page);
    expect(
      screen.getByRole("heading", { level: 1, name: "Contributors" })
    ).toBeInTheDocument();
  });

  it("renders every credited handle with its singular/plural contribution count", async () => {
    const page = await ContributorsPage();
    render(page);

    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("3 contributions")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
    expect(screen.getByText("1 contribution")).toBeInTheDocument();
  });

  it("renders exactly the credited contributors the data layer returned — nothing invented, nothing dropped", async () => {
    const page = await ContributorsPage();
    render(page);

    // Scoped to the credited-list region (its sr-only h2), not a bare
    // getByRole("list") — the breadcrumb's <ol> is also role "list".
    const region = screen.getByRole("region", { name: "All credited contributors" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(CREDITS.length);
  });

  it("does not render a handle absent from the data layer's returned credits", async () => {
    // "carol" stands in for an unapproved/unattributed contribution — proof
    // that the page only ever renders what getContributorCredits returned,
    // which is exactly where the approved+opt-in filtering already lives
    // (see lib/data.ts's getContributorCredits SQL where-clause).
    const page = await ContributorsPage();
    render(page);
    expect(screen.queryByText("carol")).not.toBeInTheDocument();
  });

  it("renders a stat row with the contributor count and total credited contributions", async () => {
    const page = await ContributorsPage();
    render(page);

    // "Contributors" also appears as the h1 and the current breadcrumb
    // crumb, so the stat tile is located by its figure ("2") and scoped
    // with `within` rather than a bare screen.getByText("Contributors").
    const countTile = screen.getByText("2").closest("div");
    if (!countTile) throw new Error("no tile wrapping the contributor count");
    expect(within(countTile).getByText("Contributors")).toBeInTheDocument();

    const totalTile = screen.getByText("4").closest("div");
    if (!totalTile) throw new Error("no tile wrapping the total credited count");
    expect(within(totalTile).getByText("Credited contributions")).toBeInTheDocument();
  });
});

describe("ContributorsPage — punctuation-collision fragments (dedupe key coarser than slugify)", () => {
  // "Jane Doe" and "Jane-Doe" differ only in internal punctuation. They are
  // distinct rows from getContributorCredits — its GROUP BY key is
  // lower(trim(...)), coarser than slugify()'s "collapse any run of
  // non-alphanumerics" behavior — but both slugify() to "jane-doe". Without
  // per-page de-duplication this produces two <li id="jane-doe"> elements:
  // invalid HTML, and a JSON-LD url fragment that can't tell them apart.
  const COLLIDING_CREDITS: ContributorCredit[] = [
    { attribution: "Jane Doe", count: 2 },
    { attribution: "Jane-Doe", count: 1 },
  ];

  beforeEach(() => {
    mockGetContributorCredits.mockResolvedValue(COLLIDING_CREDITS);
  });

  it("assigns distinct, non-empty ids to attributions that collide under slugify()", async () => {
    const { container } = render(await ContributorsPage());

    const janeDoeRow = screen.getByText("Jane Doe").closest("li");
    const janeDashDoeRow = screen.getByText("Jane-Doe").closest("li");
    if (!janeDoeRow || !janeDashDoeRow) {
      throw new Error("expected both colliding attributions to render as list items");
    }

    expect(janeDoeRow.id).toBe("jane-doe");
    expect(janeDashDoeRow.id).not.toBe("");
    expect(janeDashDoeRow.id).not.toBe(janeDoeRow.id);

    // No duplicate DOM ids anywhere on the page — invalid HTML otherwise.
    expect(container.querySelectorAll(`#${janeDoeRow.id}`)).toHaveLength(1);
  });

  it("keeps the JSON-LD ItemList url fragment in sync with the rendered <li id>", async () => {
    const { container } = render(await ContributorsPage());

    const janeDoeRow = screen.getByText("Jane Doe").closest("li");
    const janeDashDoeRow = screen.getByText("Jane-Doe").closest("li");
    if (!janeDoeRow || !janeDashDoeRow) {
      throw new Error("expected both colliding attributions to render as list items");
    }

    const jsonLdScripts = container.querySelectorAll('script[type="application/ld+json"]');
    const itemListScript = Array.from(jsonLdScripts).find((script) =>
      script.innerHTML.includes("ItemList")
    );
    if (!itemListScript) throw new Error("expected an ItemList JSON-LD script");

    expect(itemListScript.innerHTML).toContain(`#${janeDoeRow.id}`);
    expect(itemListScript.innerHTML).toContain(`#${janeDashDoeRow.id}`);
  });
});

describe("ContributorsPage — near-empty (n=1, the real current prod shape)", () => {
  // Matches live prod exactly as measured 2026-09-11: one distinct opted-in
  // handle ("Public Evidence Project") across 8 approved submissions. This
  // is the case that actually matters to eyeball — a single-item list, not
  // a card grid with one lonely tile and an empty second column.
  const SINGLE_CREDIT: ContributorCredit[] = [
    { attribution: "Public Evidence Project", count: 8 },
  ];

  beforeEach(() => {
    mockGetContributorCredits.mockResolvedValue(SINGLE_CREDIT);
  });

  it("renders exactly one row for the sole contributor — no empty grid cell beside it", async () => {
    const page = await ContributorsPage();
    render(page);

    const region = screen.getByRole("region", { name: "All credited contributors" });
    const items = within(region).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(within(items[0]).getByText("Public Evidence Project")).toBeInTheDocument();
    expect(within(items[0]).getByText("8 contributions")).toBeInTheDocument();
  });

  it("anchors the row at the slugified handle for the ItemList JSON-LD's in-page link target", async () => {
    const { container } = render(await ContributorsPage());
    expect(container.querySelector("#public-evidence-project")).not.toBeNull();
  });

  it("reads the stat row as 1 contributor / 8 credited contributions, not a plural-looking grid count", async () => {
    const page = await ContributorsPage();
    render(page);

    const countTile = screen.getByText("1").closest("div");
    if (!countTile) throw new Error("no tile wrapping the contributor count");
    expect(within(countTile).getByText("Contributors")).toBeInTheDocument();

    const totalTile = screen.getByText("8").closest("div");
    if (!totalTile) throw new Error("no tile wrapping the total credited count");
    expect(within(totalTile).getByText("Credited contributions")).toBeInTheDocument();
  });
});

describe("ContributorsPage — empty state (n=0)", () => {
  beforeEach(() => {
    mockGetContributorCredits.mockResolvedValue([]);
  });

  it("renders an honest empty-state message instead of an empty grid", async () => {
    const page = await ContributorsPage();
    render(page);

    expect(screen.getByText(/No public credits yet/i)).toBeInTheDocument();
    // The breadcrumb's <ol> is still role "list" even at n=0, so absence is
    // asserted on the credited-list region instead of a bare role query.
    expect(
      screen.queryByRole("region", { name: "All credited contributors" })
    ).not.toBeInTheDocument();
  });

  it("links the empty state to /contribute", async () => {
    const page = await ContributorsPage();
    render(page);

    expect(screen.getByRole("link", { name: "every submission" })).toHaveAttribute(
      "href",
      "/contribute"
    );
  });

  it("still renders the h1 at n=0", async () => {
    const page = await ContributorsPage();
    render(page);
    expect(
      screen.getByRole("heading", { level: 1, name: "Contributors" })
    ).toBeInTheDocument();
  });
});
