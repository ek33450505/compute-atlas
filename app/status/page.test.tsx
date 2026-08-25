import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

import type { Status } from "@/lib/status";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mock
// through vi.hoisted() so its initialization is hoisted alongside the
// vi.mock call itself, rather than relying on a plain top-level const.
const { mockGetStatusCounts } = vi.hoisted(() => ({
  mockGetStatusCounts: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getStatusCounts: mockGetStatusCounts,
}));

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

import StatusIndexPage from "./page";

// operational is deliberately >= 1000 to prove the stat row (and the A6b
// per-status grid fix) apply toLocaleString() rather than the raw number.
const COUNTS: Record<Status, number> = {
  operational: 1234,
  under_construction: 56,
  permitted: 12,
  proposed: 78,
  cancelled: 3,
};
const TOTAL = Object.values(COUNTS).reduce((sum, n) => sum + n, 0);

/** The tile is the nearest wrapping div that holds exactly one figure + its caption. */
function tileFor(text: string): HTMLElement {
  const el = screen.getByText(text);
  const tile = el.closest("div");
  if (!tile) throw new Error(`no tile wrapping "${text}"`);
  return tile;
}

beforeEach(() => {
  mockGetStatusCounts.mockReset();
  mockGetStatusCounts.mockResolvedValue(COUNTS);
});

describe("StatusIndexPage", () => {
  it("renders the overview section heading", async () => {
    const page = await StatusIndexPage();
    render(page);

    expect(
      screen.getByRole("heading", { level: 2, name: "What status means here" })
    ).toBeInTheDocument();
  });

  it("renders a 4-tile stat row, each value paired with its own label, with thousands separators", async () => {
    const page = await StatusIndexPage();
    render(page);

    const tiles = [
      { value: TOTAL.toLocaleString(), label: "Tracked sites" },
      { value: "1,234", label: "Operational" },
      { value: "56", label: "Under construction" },
      { value: "78", label: "Proposed" },
    ];

    for (const { value, label } of tiles) {
      expect(within(tileFor(value)).getByText(label)).toBeInTheDocument();
    }
    expect(tileFor("1,234").parentElement?.children).toHaveLength(tiles.length);
  });

  it("formats the per-status grid count with thousands separators (A6b regression)", async () => {
    const page = await StatusIndexPage();
    render(page);

    expect(screen.getByText("1,234 sites")).toBeInTheDocument();
    expect(screen.queryByText("1234 sites")).not.toBeInTheDocument();
  });

  it("links the reception sentence to the opposition lens", async () => {
    const page = await StatusIndexPage();
    render(page);

    const link = screen.getByRole("link", { name: "opposition lens" });
    expect(link).toHaveAttribute("href", "/opposition");
  });
});
