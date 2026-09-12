import { vi, describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself (same pattern as app/crypto/page.test.tsx /
// app/gaps/page.test.tsx).
const { mockGetStates, mockGetOperators, mockGetCounties } = vi.hoisted(() => ({
  mockGetStates: vi.fn(),
  mockGetOperators: vi.fn(),
  mockGetCounties: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getStates: mockGetStates,
  getOperators: mockGetOperators,
  getCounties: mockGetCounties,
}));

// next/link renders to <a> — mock to avoid Next.js router-context dependency
// in jsdom (same pattern as app/crypto/page.test.tsx / app/gaps/page.test.tsx).
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

import ExplorePage from "./page";

describe("ExplorePage", () => {
  it("renders a 'Help fill the gaps' card linking to /gaps with an accessible name", async () => {
    mockGetStates.mockResolvedValue(["CA", "TX"]);
    mockGetOperators.mockResolvedValue(["Operator A"]);
    mockGetCounties.mockResolvedValue([{ slug: "loudoun-va", name: "Loudoun", state: "VA", count: 2 }]);

    const page = await ExplorePage();
    render(page);

    const gapsLink = screen.getByRole("link", { name: /help fill the gaps/i });
    expect(gapsLink).toHaveAttribute("href", "/gaps");
  });

  it("places the gaps card between Learn and Download in the grid", async () => {
    mockGetStates.mockResolvedValue(["CA", "TX"]);
    mockGetOperators.mockResolvedValue(["Operator A"]);
    mockGetCounties.mockResolvedValue([{ slug: "loudoun-va", name: "Loudoun", state: "VA", count: 2 }]);

    const page = await ExplorePage();
    render(page);

    const links = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    const learnIndex = links.indexOf("/learn");
    const gapsIndex = links.indexOf("/gaps");
    const downloadIndex = links.indexOf("/data");

    expect(learnIndex).toBeGreaterThanOrEqual(0);
    expect(gapsIndex).toBe(learnIndex + 1);
    expect(downloadIndex).toBe(gapsIndex + 1);
  });

  it("renders a Counties card linking to /counties, with a derived county-count stat", async () => {
    mockGetStates.mockResolvedValue(["CA", "TX"]);
    mockGetOperators.mockResolvedValue(["Operator A"]);
    mockGetCounties.mockResolvedValue([
      { slug: "loudoun-va", name: "Loudoun", state: "VA", count: 2 },
      { slug: "maricopa-az", name: "Maricopa", state: "AZ", count: 3 },
      { slug: "santa-clara-ca", name: "Santa Clara", state: "CA", count: 1 },
    ]);

    const page = await ExplorePage();
    render(page);

    const countiesLink = screen.getByRole("link", { name: /counties/i });
    expect(countiesLink).toHaveAttribute("href", "/counties");
    // Derived from the mocked list length, not hardcoded in the page — a
    // page that hardcoded "636 counties" would fail this against 3 mocks.
    expect(countiesLink).toHaveTextContent("3 counties");
  });

  it("places the Counties card directly after By metro", async () => {
    mockGetStates.mockResolvedValue(["CA", "TX"]);
    mockGetOperators.mockResolvedValue(["Operator A"]);
    mockGetCounties.mockResolvedValue([
      { slug: "loudoun-va", name: "Loudoun", state: "VA", count: 2 },
    ]);

    const page = await ExplorePage();
    render(page);

    const links = screen.getAllByRole("link").map((l) => l.getAttribute("href"));
    expect(links.indexOf("/counties")).toBe(links.indexOf("/metros") + 1);
  });
});
