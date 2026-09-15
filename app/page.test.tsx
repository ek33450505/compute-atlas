import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// vi.mock calls are hoisted above imports, so the shared mock fns go through
// vi.hoisted() (same pattern as app/power/page.test.tsx).
const {
  mockGetStats,
  mockGetNotableFacilities,
  mockGetRecentActivity,
  mockGetAllFacilities,
  mockGetCommunityReceptionCounts,
  mockGetAiClassificationCounts,
  mockGetFacilityTypeCounts,
  mockGetNotableOppositionCases,
  mockGetGenerationBuildoutStats,
  mockGetWaterStressExposure,
  mockGetFrictionTotal,
  mockGetCounties,
  mockGetQuarterlyPipelineSummary,
  mockGetDatasetEdition,
} = vi.hoisted(() => ({
  mockGetStats: vi.fn(),
  mockGetNotableFacilities: vi.fn(),
  mockGetRecentActivity: vi.fn(),
  mockGetAllFacilities: vi.fn(),
  mockGetCommunityReceptionCounts: vi.fn(),
  mockGetAiClassificationCounts: vi.fn(),
  mockGetFacilityTypeCounts: vi.fn(),
  mockGetNotableOppositionCases: vi.fn(),
  mockGetGenerationBuildoutStats: vi.fn(),
  mockGetWaterStressExposure: vi.fn(),
  mockGetFrictionTotal: vi.fn(),
  mockGetCounties: vi.fn(),
  mockGetQuarterlyPipelineSummary: vi.fn(),
  mockGetDatasetEdition: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getStats: mockGetStats,
  getNotableFacilities: mockGetNotableFacilities,
  getRecentActivity: mockGetRecentActivity,
  getAllFacilities: mockGetAllFacilities,
  getCommunityReceptionCounts: mockGetCommunityReceptionCounts,
  getAiClassificationCounts: mockGetAiClassificationCounts,
  getFacilityTypeCounts: mockGetFacilityTypeCounts,
  getNotableOppositionCases: mockGetNotableOppositionCases,
  getGenerationBuildoutStats: mockGetGenerationBuildoutStats,
  getWaterStressExposure: mockGetWaterStressExposure,
  getFrictionTotal: mockGetFrictionTotal,
  getCounties: mockGetCounties,
  getQuarterlyPipelineSummary: mockGetQuarterlyPipelineSummary,
}));

// Pinned so the provenance line's date is deterministic — the real helper
// reads data/facilities.meta.json, which every data wave moves.
vi.mock("@/lib/dataset-edition", () => ({
  getDatasetEdition: mockGetDatasetEdition,
}));

// MapLibre needs `window` at module scope and is pure decoration here — but
// the `plate` prop is NOT decoration: it is the static dot map, rendered on
// this page (the server component) precisely so the `"use client"` wrapper
// never imports its ~23 KB path artifact. The stand-in renders it so that
// wiring is observable; it is deliberately OUTSIDE the aria-hidden div,
// because the real wrapper does not hide the plate either.
vi.mock("@/components/home/hero-globe-dynamic", () => ({
  HeroGlobe: ({ plate }: { plate?: React.ReactNode }) => (
    <>
      <div aria-hidden="true" />
      {plate}
    </>
  ),
}));

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

import HomePage from "./page";
import { HERO_PLATE } from "@/components/home/hero-plate-paths";

const STATE_CODES = ["CA", "TX", "VA", "DC"];

// The component renders this count through `toLocaleString("en-US")`
// (components/home/hero-provenance.tsx), so the expectation has to format it
// the same way. Raw interpolation agrees below 1000 and diverges at 1000
// ("1000" vs "1,000"), so a data wave that pushed `omitted` past 999 would turn
// this suite red for a formatting reason, under a message blaming the
// disclosure text. Extracted rather than inlined so that 4-digit behaviour can
// be asserted directly (below) instead of waiting for such a wave to arrive.
const nf = new Intl.NumberFormat("en-US");
const omittedDisclosure = (omitted: number) =>
  `static map omits ${nf.format(omitted)} in U.S. territories`;

/** Three facilities carrying 7 sources between them. */
const FACILITIES = [
  {
    id: "a",
    name: "Alpha",
    operator: "Acme",
    lastUpdated: "2026-09-01",
    energy: { utility: "Dominion" },
    sources: [{ url: "https://x/1" }, { url: "https://x/2" }, { url: "https://x/3" }],
  },
  {
    id: "b",
    name: "Bravo",
    operator: "Beta Corp",
    lastUpdated: "2026-09-02",
    sources: [{ url: "https://x/4" }, { url: "https://x/5" }],
  },
  {
    id: "c",
    name: "Charlie",
    operator: "Acme",
    lastUpdated: "2026-09-03",
    sources: [{ url: "https://x/6" }, { url: "https://x/7" }],
  },
];

beforeEach(() => {
  mockGetDatasetEdition.mockReturnValue({
    version: "1.30.0",
    asOf: "2026-09-15T00:00:00.000Z",
    recordCount: 1900,
    schemaVersion: 2,
  });
  mockGetStats.mockResolvedValue({
    count: 1929,
    states: 3,
    includesDc: true,
    stateCodes: STATE_CODES,
    operationalMw: 12000,
    plannedMw: 40000,
    underConstructionMw: 5000,
  });
  mockGetNotableFacilities.mockResolvedValue([]);
  mockGetRecentActivity.mockResolvedValue([]);
  mockGetAllFacilities.mockResolvedValue(FACILITIES);
  mockGetCommunityReceptionCounts.mockResolvedValue({
    litigation: 2,
    opposed: 3,
    contested: 4,
    supportive: 1,
    mixed: 0,
    neutral: 0,
  });
  mockGetFrictionTotal.mockReturnValue(9);
  mockGetAiClassificationCounts.mockResolvedValue({
    confirmed: 10,
    likely: 5,
    mixed_use: 2,
  });
  mockGetFacilityTypeCounts.mockResolvedValue({
    data_center: 50,
    crypto_mining: 7,
    power_generation: 3,
  });
  mockGetNotableOppositionCases.mockResolvedValue([]);
  mockGetGenerationBuildoutStats.mockResolvedValue({
    fossilPlannedMw: 69203,
    nonFossilPlannedMw: 19372,
    fossilPlants: 30,
    nonFossilPlants: 12,
    gas: {
      total: 80,
      operational: 15,
      proposed: 40,
      permitted: 15,
      underConstruction: 10,
    },
  });
  mockGetWaterStressExposure.mockResolvedValue({
    rated: 1651,
    highOrExtreme: 549,
  });
  mockGetCounties.mockResolvedValue([{ slug: "loudoun-va" }]);
  mockGetQuarterlyPipelineSummary.mockResolvedValue({
    newThisQuarter: 0,
    cancelledThisQuarter: 0,
    statusChangesThisQuarter: 0,
  });
});

/**
 * The provenance rule, located by its edition date. Scoped rather than
 * asserted against the whole page: OpenRecord legitimately renders a
 * "Recently updated" heading, so a page-wide "updated" assertion would be
 * testing the wrong element.
 */
function provenanceLine(): HTMLElement {
  return screen.getByText(/edition 15 Sep 2026/);
}

/**
 * The cartouche: the wrapper holding the hero's bare text. Located by walking
 * up from the H1 rather than by a class, because its identity here is
 * structural — it is whatever element the scrim is sized against.
 */
function cartouche(): HTMLElement {
  const h1 = screen.getByRole("heading", { level: 1 });
  expect(h1.parentElement).not.toBeNull();
  return h1.parentElement as HTMLElement;
}

describe("HomePage hero", () => {
  it("renders the H1 verbatim", async () => {
    render(await HomePage());

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "America’s data centers, mapped and sourced.",
      })
    ).toBeInTheDocument();
  });

  it("renders a single subhead paragraph", async () => {
    render(await HomePage());

    expect(
      screen.getByText(
        /Public data on data centers is everywhere and nowhere/
      )
    ).toBeInTheDocument();
    // The second paragraph ("Track what's being built, where…") was cut to
    // reclaim the fold — it must not come back silently.
    expect(
      screen.queryByText(/how much of its cost to power, water, and neighbors/)
    ).not.toBeInTheDocument();
  });

  it("renders the provenance rule with the LIVE site and source counts", async () => {
    render(await HomePage());

    const line = provenanceLine();
    expect(line).toHaveTextContent("1,929 sites");
    expect(line).toHaveTextContent("3 states and DC");
    expect(line).toHaveTextContent("7 sources");
  });

  it("labels the snapshot date `edition`, never `updated`", async () => {
    render(await HomePage());

    const line = provenanceLine();
    expect(line.textContent).toContain("edition 15 Sep 2026");
    expect(line.textContent).not.toContain("updated");
    expect(line.textContent).not.toContain("Updated");
    // edition.recordCount (1,900) is a snapshot figure and must never appear
    // next to the live count on this line.
    expect(line.textContent).not.toContain("1,900");
  });

  it("omits the quarter segment when the quarter is empty", async () => {
    render(await HomePage());

    expect(provenanceLine().textContent).not.toContain("this quarter");
  });

  it("renders the quarter segment when the quarter moved", async () => {
    mockGetQuarterlyPipelineSummary.mockResolvedValue({
      newThisQuarter: 41,
      cancelledThisQuarter: 3,
      statusChangesThisQuarter: 12,
    });
    render(await HomePage());

    expect(provenanceLine().textContent).toContain(
      "+41 new this quarter, 3 cancelled"
    );
  });

  // The plate's OWN accessible name cannot carry this: that <svg role="img">
  // is replaced by the aria-hidden globe canvas as soon as MapLibre mounts, so
  // on desktop the disclosure was announced or not depending on timing. The
  // provenance rule is on the page in every state, at every viewport.
  it("discloses on the provenance rule what the static map cannot place", async () => {
    // Precondition for the plural branch — a wave that dropped this to 1 would
    // render "1 in a U.S. territory" and should fail loudly here, not silently
    // stop matching.
    expect(HERO_PLATE.omitted).toBeGreaterThan(1);

    render(await HomePage());

    expect(provenanceLine().textContent).toContain(
      omittedDisclosure(HERO_PLATE.omitted)
    );
  });

  // Proves the formatting above rather than trusting it. Today's
  // HERO_PLATE.omitted is a 2-digit number, where raw interpolation and en-US
  // formatting produce the identical string — so the assertion above cannot
  // distinguish the two and would pass either way. This pins the 4-digit case
  // the suite would otherwise first meet on the day a data wave broke it.
  it("formats the omitted count with thousands separators past 999", () => {
    expect(omittedDisclosure(1000)).toBe(
      "static map omits 1,000 in U.S. territories"
    );
    expect(omittedDisclosure(12)).toBe("static map omits 12 in U.S. territories");
  });

  // The hero wrapper is a client component; the plate is a server-rendered
  // node handed to it as a prop. If this page stopped passing it, every
  // non-globe state (which is EVERY state on a phone) would show a bare
  // graticule and no map at all — and no test in hero-globe.test.tsx would
  // notice, because there the plate is supplied by the test itself.
  it("hands the hero wrapper a server-rendered dot plate", async () => {
    render(await HomePage());

    // Scoped by accessible NAME, not a bare getByRole("img"). The hero is about
    // to gain a legend and caption, and an unscoped query would then throw
    // "found multiple elements with the role img" — a failure that says nothing
    // about whether the plate is still being handed across the boundary, which
    // is the only thing this test is here to catch. Naming it means the next
    // unit gets a real failure (the plate is gone / renamed) or none at all.
    const plate = screen.getByRole("img", {
      name: /Dot map of [\d,]+ tracked sites/,
    });
    // role="img" is also reachable from <img> and <div role="img">; this is the
    // server-rendered inline SVG or it is not the plate.
    expect(plate.tagName.toLowerCase()).toBe("svg");
  });

  it("keeps the primary map CTA pointing at /map", async () => {
    render(await HomePage());

    expect(
      screen.getByRole("link", { name: /Explore the map/ })
    ).toHaveAttribute("href", "/map");
  });

  // The trailing → is decorative and aria-hidden, so it is excluded from the
  // accessible name — a screen reader must not announce "How this is sourced
  // right arrow". `toHaveAccessibleName` with a STRING compares the raw
  // computed name exactly (no whitespace normalization, unlike getByRole's
  // own name matcher), and the name computes to "How this is sourced" with no
  // trailing space: accname trims, so the space before the hidden span is
  // dropped. Measured, not assumed.
  it("offers the sourcing link as a named second action, without the arrow in its accessible name", async () => {
    render(await HomePage());

    const link = screen.getByRole("link", { name: "How this is sourced" });

    expect(link).toHaveAttribute("href", "/methodology");
    expect(link).toHaveAccessibleName("How this is sourced");
  });

  // A >=44px touch target on the quiet text link beside the h-11 map CTA,
  // plus the backing that keeps it readable.
  //
  // jsdom computes no layout, so the class list is the only assertable
  // surface here; the rendered geometry is covered by the a11y e2e pass.
  //
  // The bg-background/85 + backdrop-blur-sm + px-2 trio is asserted for
  // LEGIBILITY, not aesthetics: the hero's parchment scrim is sized by the
  // text block above and stops short of this CTA row, so on sm+ this link
  // renders over live MapLibre tiles. Its two siblings paint their own opaque
  // fills (solid bg-primary, bg-card) and need no backing; this one paints
  // nothing, so without the plate --muted-foreground's audited 6.70:1 (which
  // assumes parchment behind it) does not hold.
  //
  // A class assertion is the honest limit here. jsdom does no layout and no
  // compositing, so this CANNOT prove contrast — it only proves the backing
  // has not been silently stripped as decoration. Real contrast over tiles is
  // unverifiable in this suite.
  it("gives the sourcing link a 44px-tall hit area and a backing that survives over map tiles", async () => {
    render(await HomePage());

    const link = screen.getByRole("link", { name: "How this is sourced" });

    expect(link).toHaveClass("inline-flex");
    expect(link).toHaveClass("min-h-11");
    expect(link).toHaveClass("items-center");
    expect(link).toHaveClass("bg-background/85");
    expect(link).toHaveClass("backdrop-blur-sm");
    expect(link).toHaveClass("px-2");
  });

  // The scrim used to span the whole hero box with hand-measured percentage
  // stops, which every copy edit silently invalidated. It is now a child of
  // the text block, so it is sized by what it protects. jsdom computes no
  // layout, so what is assertable here is the CONTAINMENT that makes that
  // true — which is exactly the part a refactor would break.
  it("backs the cartouche with a decorative scrim sized by the text block", async () => {
    render(await HomePage());

    const block = cartouche();
    const scrim = block.firstElementChild;

    expect(scrim).not.toBeNull();
    expect(scrim).toHaveAttribute("aria-hidden", "true");
    // Decorative and click-through: it sits over the map, so it must never
    // intercept a pointer event aimed at the globe beneath it.
    expect(scrim).toHaveClass("pointer-events-none");
    // Sized by its offset parent, which the wrapper only is while positioned
    // — drop `relative` and the scrim escapes to the hero box, restoring the
    // hero-relative coupling this structure exists to remove.
    expect(scrim).toHaveClass("absolute");
    expect(block).toHaveClass("relative");
    // Behind every sibling in the hero block (and NOT isolated), so the tail
    // bleeding past the text passes under the search card instead of over it.
    expect(scrim).toHaveClass("-z-10");
    expect(block).not.toHaveClass("isolate");

    // A horizontal offset PAIR — not its magnitude — is what gives this
    // absolutely-positioned box a resolved width. Without one it shrink-wraps
    // its (empty) content instead of spanning the wrapper, so deleting the
    // class collapses the scrim rather than trimming its bleed. The magnitude
    // is deliberately NOT pinned: -inset-x-4's extra 16px per side is headroom
    // the hero's overflow-hidden clips today, so inset-x-0 would render
    // identically and is a legitimate future edit. Removal is not.
    expect(scrim!.className).toMatch(/(^|\s)-?inset-x-/);

    // The fade is anchored in PIXELS, so the opaque region ends on the text
    // block's bottom edge at EVERY content height. 24px is the real bottom
    // bleed, not the 40px `-bottom-10` advertises: `space-y-4` compiles to
    // `margin-block-end: 1rem` on `:not(:last-child)` and the scrim is child
    // 1 of 5, and CSS 2.1 §10.6.4 subtracts that margin from an auto-height
    // box that sets both `top` and `bottom` — so the height resolves to
    // H + 40 + 40 − 16, leaving 24px below the text.
    //
    // HONEST LIMIT: jsdom computes no layout and resolves no gradient, so
    // this is necessarily a structural/class assertion, NOT a rendered-
    // geometry one. It cannot prove the text is covered. What it does prove
    // is that the pixel anchor has not been swapped back for content-relative
    // percentage stops — the regression that put <HeroProvenance>, the
    // lowest-contrast line on the page, inside the fade instead of the opaque
    // band. Real contrast over map tiles is unverifiable in this suite.
    expect(scrim).toHaveClass(
      "bg-[linear-gradient(to_bottom,var(--background)_0,var(--background)_calc(100%_-_24px),transparent_100%)]"
    );
    // No content-relative gradient stop survives anywhere in the class list:
    // `via-background/92 via-92%` is exactly what this replaced.
    expect(scrim!.className).not.toMatch(/(^|\s)(from|via|to)-\d+%/);

    // …and it spans all of the bare text, not just the heading.
    expect(block).toContainElement(
      screen.getByText(/Public data on data centers is everywhere and nowhere/)
    );
    expect(block).toContainElement(provenanceLine());
  });

  // The class that actually traps the scrim in the right stacking context is
  // the `z-10` on the cartouche's PARENT, not the `-z-10` on the scrim itself.
  // `relative` alone leaves `z-index: auto`, which creates NO stacking
  // context; `relative` + `z-10` does. That is what makes the scrim's negative
  // z-index resolve inside the hero block — behind its own siblings, but still
  // in front of <HeroGlobe>. Strip the `z-10` and the scrim escapes to the
  // nearest ancestor stacking context and paints BEHIND the globe, leaving the
  // cartouche completely unbacked over live map tiles.
  //
  // Every other assertion in this file passes in that broken state, including
  // the `-z-10` / `not.toHaveClass("isolate")` pair above — which is precisely
  // why this test exists. Mutation-tested: removing `z-10` from app/page.tsx
  // fails this and nothing else.
  it("anchors the scrim's stacking context on the cartouche's parent", async () => {
    render(await HomePage());

    const heroBlock = cartouche().parentElement;

    expect(heroBlock).not.toBeNull();
    expect(heroBlock).toHaveClass("relative");
    expect(heroBlock).toHaveClass("z-10");
  });

  it("keeps the search box and both CTAs outside the scrimmed text block", async () => {
    render(await HomePage());

    const block = cartouche();

    // These three paint their own backgrounds (bg-card, solid bg-primary) and
    // are legible over the map unaided. A scrim stretched to cover them was
    // measured burying everything except the Gulf — pulling any of them into
    // the wrapper above would silently reinstate that.
    expect(block).not.toContainElement(
      screen.getByRole("button", { name: /opens a search dialog/ })
    );
    expect(block).not.toContainElement(
      screen.getByRole("link", { name: /Explore the map/ })
    );
    expect(block).not.toContainElement(
      screen.getByRole("link", { name: "How this is sourced" })
    );
  });
});
