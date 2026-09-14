import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mocks
// through vi.hoisted() so their initialization is hoisted alongside the
// vi.mock call itself, rather than relying on plain top-level consts.
const {
  mockGetAiClassificationByState,
  mockGetAiClassificationCounts,
  mockGetFacilityTypeCounts,
} = vi.hoisted(() => ({
  mockGetAiClassificationByState: vi.fn(),
  mockGetAiClassificationCounts: vi.fn(),
  mockGetFacilityTypeCounts: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getAiClassificationByState: mockGetAiClassificationByState,
  getAiClassificationCounts: mockGetAiClassificationCounts,
  getFacilityTypeCounts: mockGetFacilityTypeCounts,
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

import AiPage from "./page";

/**
 * Locates a survey-stat tile by its LABEL (not its bare number) — a
 * per-state row's total can coincidentally match a tile's number, so this is
 * scoped to the tile caption's specific `<span class="... text-muted-foreground">`.
 * That also keeps the masthead eyebrow out of range — it renders as a
 * `<p class="... text-primary">` (components/page-masthead.tsx) and on some
 * sibling pages carries text close enough to a tile label to match.
 */
function tileByLabel(label: string): HTMLElement {
  const matches = screen
    .getAllByText(label)
    .filter(
      (el) => el.tagName === "SPAN" && el.classList.contains("text-muted-foreground")
    );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one survey-stat tile labeled "${label}", found ${matches.length}`
    );
  }
  const tile = matches[0].closest("div");
  if (!tile) throw new Error(`no tile wrapping label "${label}"`);
  return tile;
}

beforeEach(() => {
  mockGetAiClassificationByState.mockReset();
  mockGetAiClassificationCounts.mockReset();
  mockGetFacilityTypeCounts.mockReset().mockResolvedValue({
    data_center: 10,
    crypto_mining: 0,
    power_generation: 0,
  });
});

describe("AiPage — states tile DC wording", () => {
  it("labels the states tile 'States' and shows the state count when no AI-classified data center is in DC", async () => {
    mockGetAiClassificationByState.mockResolvedValue([
      { state: "NY", counts: { confirmed: 2, likely: 0, mixed_use: 0 } },
      { state: "TX", counts: { confirmed: 1, likely: 1, mixed_use: 0 } },
    ]);
    mockGetAiClassificationCounts.mockResolvedValue({ confirmed: 3, likely: 1, mixed_use: 0 });

    const page = await AiPage();
    render(page);

    // 2 distinct states (NY, TX), no DC.
    expect(within(tileByLabel("States")).getByText("2")).toBeInTheDocument();
    expect(screen.queryByText("States + DC")).not.toBeInTheDocument();
  });

  it("labels the states tile 'States + DC' and shows the state count (2), not the raw jurisdiction total (3), when an AI-classified data center is in DC", async () => {
    mockGetAiClassificationByState.mockResolvedValue([
      { state: "NY", counts: { confirmed: 2, likely: 0, mixed_use: 0 } },
      { state: "TX", counts: { confirmed: 1, likely: 1, mixed_use: 0 } },
      { state: "DC", counts: { confirmed: 0, likely: 0, mixed_use: 1 } },
    ]);
    mockGetAiClassificationCounts.mockResolvedValue({ confirmed: 3, likely: 1, mixed_use: 1 });

    const page = await AiPage();
    render(page);

    // The bug this guards: the tile's VALUE must be the state count (2: NY,
    // TX), not the raw jurisdiction total (3: NY, TX, DC) — "3 / States + DC"
    // reads as "three states, plus DC."
    const tile = tileByLabel("States + DC");
    expect(within(tile).getByText("2")).toBeInTheDocument();
    expect(within(tile).queryByText("3")).not.toBeInTheDocument();
    expect(screen.queryByText("States")).not.toBeInTheDocument();
  });
});

describe("AiPage — survey stat row", () => {
  it("renders AI-classified / Confirmed / Likely / States tiles in order", async () => {
    mockGetAiClassificationByState.mockResolvedValue([
      { state: "NY", counts: { confirmed: 2, likely: 0, mixed_use: 0 } },
      { state: "TX", counts: { confirmed: 1, likely: 1, mixed_use: 0 } },
    ]);
    mockGetAiClassificationCounts.mockResolvedValue({ confirmed: 3, likely: 1, mixed_use: 0 });

    const page = await AiPage();
    render(page);

    const tiles = [
      { label: "AI-classified", value: "4" },
      { label: "Confirmed", value: "3" },
      { label: "Likely", value: "1" },
      { label: "States", value: "2" },
    ];
    for (const { label, value } of tiles) {
      expect(within(tileByLabel(label)).getByText(value)).toBeInTheDocument();
    }
    expect(tileByLabel("AI-classified").parentElement?.children).toHaveLength(tiles.length);
  });
});
