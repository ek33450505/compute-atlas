import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
  includesDc: false,
  stateCodes: ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VA", "VT"],
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

  it("captions the states tile 'States covered' with a DC footnote, animating the number to the actual state count (50) not the raw jurisdiction total (51), when the dataset includes DC", () => {
    setReducedMotion(true);
    render(<SurveyLedger {...PROPS} states={51} includesDc={true} stateCodes={["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DC", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VA", "VT", "WA", "WI", "WV", "WY"]} />);

    // The bug this guards: the tile's animated number must land on the
    // actual state count (50), not the raw distinct-code total (51) — "51 /
    // States covered" reads as "fifty-one states" whether or not a footnote
    // follows. Reverting the count-up target back to the raw `states` prop
    // fails this and the "51" negative below.
    expect(screen.getByText("50")).toBeInTheDocument();
    expect(screen.queryByText("51")).not.toBeInTheDocument();
    // The caption stays one phrase and DC moves to the footnote under the
    // row. Mutation coverage: dropping statesStat leaves the caption unmarked
    // and prints no footnote; reverting the aria text back to
    // `${states} states covered` fails the label assertions.
    expect(screen.getByText("States covered")).toBeInTheDocument();
    expect(screen.getByText("Plus the District of Columbia")).toBeInTheDocument();
    // Screen readers never see the "*" — the tile's own aria-label already
    // spells the whole figure out, which is why the marker is aria-hidden.
    // Scoped to the tile because the footnote line prints its own copy of the
    // glyph; a bare getByText("*") matches both and proves neither.
    const tile = screen.getByLabelText("50 states and DC covered");
    expect(within(tile).getByText("*")).toBeInTheDocument();
    expect(screen.queryByLabelText("51 states covered")).not.toBeInTheDocument();
  });

  it("prints no footnote and no marker when the dataset is states only", () => {
    setReducedMotion(true);
    render(<SurveyLedger {...PROPS} states={2} stateCodes={["CA", "TX"]} />);

    expect(screen.getByText("States covered")).toBeInTheDocument();
    expect(screen.queryByText("*")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Plus /)).not.toBeInTheDocument();
  });

  it("footnotes DC and the territories together when the dataset holds both", () => {
    setReducedMotion(true);
    render(
      <SurveyLedger
        {...PROPS}
        states={5}
        includesDc={true}
        stateCodes={["CA", "TX", "DC", "PR", "GU"]}
      />
    );

    // The caption is the same two words it is for a states-only dataset —
    // that invariance is the point of the footnote, since the label sits
    // under a 4xl figure and cannot absorb "+ DC + territories".
    expect(screen.getByText("States covered")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(
      screen.getByText("Plus the District of Columbia and 2 U.S. territories")
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("2 states, DC and 2 territories covered")
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

  it("centres the ledger tile row below sm and packs it left from sm up", () => {
    setReducedMotion(true);
    render(<SurveyLedger {...PROPS} />);

    // Located structurally — the row is the shared parent of the four ledger
    // tiles, not a child index or a class selector, so re-ordering the tiles
    // or restyling the row cannot silently retarget the assertion onto some
    // other element and keep passing.
    const tiles = [
      screen.getByLabelText("727 sites tracked"),
      screen.getByLabelText("45 states covered"),
      screen.getByLabelText("210 operators"),
      screen.getByLabelText("2,570 sources cited"),
    ];
    const row = tiles[0].parentElement;
    expect(row).not.toBeNull();
    tiles.forEach((tile) => expect(tile.parentElement).toBe(row));

    // Pinned because Ed QA'd and approved exactly this on a phone (2026-09-15):
    // each tile is internally centred but the row packs left, so a wrapped row
    // went ragged on iPhone widths. Centring below sm is what fixed it — losing
    // either class is a real visual regression, not style drift, and nothing
    // else in this file would notice. `flex flex-wrap` is pinned alongside
    // because `justify-*` is inert on a non-flex container: dropping `flex`
    // would un-centre the row while both justify classes still read as present.
    // Sibling guard: components/survey-stat-row.test.tsx holds an exact-string
    // toBe() on the same pair for SurveyStatRow, which this row deliberately
    // matches.
    expect(row).toHaveClass(
      "flex",
      "flex-wrap",
      "justify-center",
      "sm:justify-start"
    );
  });

  it("does not throw when motion is allowed (count-up / bar-grow code paths execute)", () => {
    setReducedMotion(false);
    expect(() => render(<SurveyLedger {...PROPS} />)).not.toThrow();
  });
});
