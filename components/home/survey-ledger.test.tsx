import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SurveyLedger, type SurveyLedgerProps } from "./survey-ledger";

// ---------------------------------------------------------------------------
// Mocks — jsdom has neither a real matchMedia nor IntersectionObserver.
// ---------------------------------------------------------------------------

const DEFAULT_MATCH_MEDIA = (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
});

/** Reports every observed target as already-intersecting, synchronously —
 * mirrors an element that is on-screen at mount. */
class MockIntersectionObserver {
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function setReducedMotion(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    ...DEFAULT_MATCH_MEDIA(query),
    matches: query.includes("prefers-reduced-motion") ? matches : false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
});

afterEach(() => {
  // Restore the global false-returning stub from vitest.setup.ts between tests.
  window.matchMedia = DEFAULT_MATCH_MEDIA as unknown as typeof window.matchMedia;
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fixtures — chosen so every derived figure (GW, %, ratio) is a clean value.
// ---------------------------------------------------------------------------

const PROPS: SurveyLedgerProps = {
  count: 727,
  states: 45,
  operators: 210,
  sources: 2570,
  operationalMw: 4000, // 4.0 GW
  underConstructionMw: 8000, // 8 GW
  plannedMw: 40000, // 40 GW — the shared axis
};

const EXPECTED_CAPTION =
  "Among sites that disclose capacity, the announced pipeline (40 GW) outweighs operating capacity (4.0 GW) by roughly 10-to-1 — 8 GW is already under construction. Sums cover disclosed capacities only.";

// ---------------------------------------------------------------------------
// Tests — the AT-REST / reduced-motion state only. jsdom has no
// IntersectionObserver/rAF timing, so intermediate animation frames are
// never asserted.
// ---------------------------------------------------------------------------

describe("SurveyLedger", () => {
  it("renders the final ledger tile numbers under reduced motion", () => {
    setReducedMotion(true);
    render(<SurveyLedger {...PROPS} />);

    expect(screen.getByText("727")).toBeInTheDocument();
    expect(screen.getByText("45")).toBeInTheDocument();
    expect(screen.getByText("210")).toBeInTheDocument();
    expect(screen.getByText("2,570")).toBeInTheDocument();
  });

  it("renders the final GW figure for each pipeline row under reduced motion", () => {
    setReducedMotion(true);
    render(<SurveyLedger {...PROPS} />);

    expect(screen.getByText("4.0 GW")).toBeInTheDocument();
    expect(screen.getByText("8 GW")).toBeInTheDocument();
    expect(screen.getByText("40 GW")).toBeInTheDocument();
  });

  it("renders the computed, honest caption with the disclosed-capacity ratio", () => {
    setReducedMotion(true);
    render(<SurveyLedger {...PROPS} />);

    expect(screen.getByText(EXPECTED_CAPTION)).toBeInTheDocument();
  });

  it("exposes an accessible final-value label per ledger tile (never a mid-animation number)", () => {
    setReducedMotion(true);
    render(<SurveyLedger {...PROPS} />);

    expect(screen.getByLabelText("727 sites tracked")).toBeInTheDocument();
    expect(screen.getByLabelText("45 states covered")).toBeInTheDocument();
    expect(screen.getByLabelText("210 operators")).toBeInTheDocument();
    expect(screen.getByLabelText("2,570 sources cited")).toBeInTheDocument();
  });

  it("exposes an accessible final-value label per pipeline row", () => {
    setReducedMotion(true);
    render(<SurveyLedger {...PROPS} />);

    expect(screen.getByLabelText("4.0 GW operating")).toBeInTheDocument();
    expect(
      screen.getByLabelText("8 GW under construction")
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("40 GW planned pipeline")
    ).toBeInTheDocument();
  });

  it("grows each pipeline bar to its exact share of the planned-capacity axis, immediately under reduced motion", () => {
    setReducedMotion(true);
    render(<SurveyLedger {...PROPS} />);

    const operating = screen.getByLabelText("4.0 GW operating");
    const underConstruction = screen.getByLabelText("8 GW under construction");
    const planned = screen.getByLabelText("40 GW planned pipeline");

    expect(
      operating.querySelector<HTMLElement>(".h-full.rounded-full")?.style
        .width
    ).toBe("10%");
    expect(
      underConstruction.querySelector<HTMLElement>(".h-full.rounded-full")
        ?.style.width
    ).toBe("20%");
    expect(
      planned.querySelector<HTMLElement>(".h-full.rounded-full")?.style.width
    ).toBe("100%");
  });

  it("renders as a labeled, accessible region and passes through className", () => {
    setReducedMotion(true);
    render(
      <SurveyLedger {...PROPS} className="mb-10 border-b border-border pb-10" />
    );

    const section = screen.getByRole("region", { name: "Dataset survey" });
    expect(section).toHaveClass("mb-10", "border-b", "border-border", "pb-10");
  });

  it("renders a screen-reader-only heading that establishes the section's accessible name", () => {
    setReducedMotion(true);
    render(<SurveyLedger {...PROPS} />);

    expect(
      screen.getByRole("heading", { level: 2, name: "Dataset survey" })
    ).toBeInTheDocument();
  });

  it("hides every bar track and fill from assistive tech (decorative)", () => {
    setReducedMotion(true);
    const { container } = render(<SurveyLedger {...PROPS} />);

    const fills = container.querySelectorAll(".h-full.rounded-full");
    expect(fills).toHaveLength(3);
    fills.forEach((fill) => {
      expect(fill).toHaveAttribute("aria-hidden", "true");
    });
  });

  it("does not throw when motion is allowed (count-up / bar-grow code paths execute)", () => {
    setReducedMotion(false);
    expect(() => render(<SurveyLedger {...PROPS} />)).not.toThrow();
  });
});
