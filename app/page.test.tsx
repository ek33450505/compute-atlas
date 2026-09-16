import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

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
  mockSelectRecordSpecimen,
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
  mockSelectRecordSpecimen: vi.fn(),
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
  selectRecordSpecimen: mockSelectRecordSpecimen,
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
    // Deliberately NOT the live figure the homepage copy was written against
    // (1,929). Every caption and stat that claims to read the live count has to
    // be provably reading THIS mock: with a fixture equal to the snapshot
    // literal, a hardcoded `count={1929}` at a call site passes identically to
    // `count={count}` and the prop chain goes untested. A synthetic value that
    // appears nowhere in the source makes that substitution fail.
    count: 2412,
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
  // Defaults to "no record clears the bar" — the degraded path every other
  // test in this file renders through, so none of them depend on the specimen.
  mockSelectRecordSpecimen.mockReturnValue(null);
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

  it("sets the H1 at the top display step, wonk axes and all", async () => {
    render(await HomePage());

    const h1 = screen.getByRole("heading", { level: 1 });
    // Three steps: this h1 (5xl→7xl), the homepage section h2s (3xl→4xl via
    // SectionHeading size="lg"), then card titles. Before this pass the page
    // ran 4xl→5xl against a flat 2xl below, which is one step, not three.
    expect(h1).toHaveClass("text-5xl", "sm:text-6xl", "lg:text-7xl");
    expect(h1).not.toHaveClass("text-4xl");
    // Fraunces' SOFT/WONK axes are already paid for in app/layout.tsx's
    // `axes` list; this is the one element that varies them. jsdom renders no
    // font, so this pins the OPT-IN only — whether the alternate glyphs
    // actually shape is a browser fact no test here can reach.
    expect(h1).toHaveClass("font-display", "font-display-wonk");
    // The measure the 7xl step was chosen against. Narrower and the 45-char
    // line breaks to three, which is what starts orphaning words.
    expect(h1).toHaveClass("max-w-4xl");
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
    expect(line).toHaveTextContent("2,412 sites");
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
  // nothing, so without the plate --foreground's 13.15:1 (which assumes
  // parchment behind it) does not hold. The link was darkened from
  // --muted-foreground's 6.70:1 on 2026-09-15, which raises the floor on that
  // unverified over-tiles case but does not remove the need for the backing.
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
    // The 2026-09-15 darkening itself, which the comment above describes and
    // nothing else pinned. Reverting this one token to `text-muted-foreground`
    // drops the link to 6.70:1 over unknown tiles while every other assertion
    // here stays green — and makes the contrast figures in that comment false.
    expect(link).toHaveClass("text-foreground");
    expect(link).toHaveClass("hover:text-primary");
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

/**
 * The hero plate's key (components/home/plate-key.tsx). Its unit tests own the
 * component's behaviour; these assert the things only the assembled page can
 * show — that it is WIRED, that it is placed where the globe swap cannot take
 * it, and that adding it did not break the sibling that shares its role.
 */
describe("HomePage plate key", () => {
  function plateKey(): HTMLElement {
    return screen.getByRole("region", { name: "Map key" });
  }

  it("decodes the plate's status colours with a named legend", async () => {
    render(await HomePage());

    // Scoped with within(), not queried page-wide: <StatusBadge> is rendered
    // elsewhere on this page (the notable-site cards), so a bare
    // getAllByText("Operational") would pass on those alone even with the key
    // deleted — an assertion about the wrong element entirely.
    const key = within(plateKey());
    for (const label of [
      "Operational",
      "Under construction",
      "Permitted",
      "Proposed",
      "Cancelled",
    ]) {
      expect(key.getByText(label)).toBeInTheDocument();
    }
  });

  // The key's own "Open the interactive map" link was removed (Ed,
  // 2026-09-15) as a duplicate of the hero's primary CTA a few lines above it.
  // Pinned here rather than only in the component's unit tests because this is
  // the assembled page, where a link re-added anywhere in the card would also
  // put the Playwright hazard below back.
  it("adds no second route into /map", async () => {
    render(await HomePage());

    expect(within(plateKey()).queryAllByRole("link")).toHaveLength(0);
  });

  // ⛔ e2e/home.spec.ts resolves the hero's primary CTA with
  // `getByRole("link", { name: /Explore the map/i })`, and Playwright's strict
  // mode FAILS on two matches. The plate key's own /map link is gone, so today
  // this page has exactly one — but the guard is page-wide, not about that
  // link: any future second link whose name falls inside that regex breaks a
  // Playwright spec this Vitest suite never runs, surfacing a whole gate later.
  // Counting matches here is what turns that into a unit-test failure.
  it("leaves exactly one link matching the primary CTA's Playwright matcher", async () => {
    render(await HomePage());

    expect(
      screen.getAllByRole("link", { name: /Explore the map/i })
    ).toHaveLength(1);
  });

  // Computed from the artifact rather than pasted as literals: every data wave
  // regenerates hero-plate-paths.ts, and hard-coded figures here would go
  // stale silently while still passing against nothing.
  it("captions the plate with exactly one number — what it draws", async () => {
    render(await HomePage());

    const covered = HERO_PLATE.total - HERO_PLATE.omitted;
    const caption = within(plateKey()).getByText(
      new RegExp(`^${nf.format(covered)} sites plotted$`)
    );

    // `covered` is total MINUS omitted, never HERO_PLATE.plotted — that counts
    // drawn MARKS and under-counts facilities wherever co-located same-status
    // sites collapse onto one. The anchored regex above is what enforces that:
    // pass HERO_PLATE.plotted instead and the getByText throws. A sibling
    // `not.toContain(plotted)` is deliberately absent — it could never run (the
    // query throws first), and it WOULD fire against correct code on any wave
    // that happens to yield `plotted === total - omitted`.
    expect(caption).toBeInTheDocument();

    // Anchored at BOTH ends, and this is the half that matters on the
    // ASSEMBLED page. The caption used to read "N of TOTAL sites plotted",
    // where TOTAL came from the build-time plate artifact while
    // <HeroProvenance>'s `sites` — rendered a few lines above, in this same
    // fold — comes from live Neon. Equal today; two different site totals one
    // line apart the first sync that lands without a plate rebuild. Restoring
    // that clause, or appending the old territory segment, fails here.
    //
    // Counting digit groups rather than asserting `not.toContain(total)`, for
    // the reason given just above about HERO_PLATE.plotted: a wave where
    // `omitted` reached 0 would make total === covered and turn that check red
    // against correct code. A count of one cannot false-fire that way.
    expect(caption.textContent?.match(/[\d,]+/g)).toHaveLength(1);
  });

  // The placement is the whole design decision. hero-globe-dynamic.tsx swaps
  // the plate node out for the aria-hidden MapLibre canvas on sm+, so a key
  // rendered inside <HeroPlate> or the `plate` prop would disappear at exactly
  // the viewports where the map is richest. It must also stay out of the
  // scrimmed text block (whose `calc(100% - 24px)` constant is derived from
  // that wrapper's child count).
  it("renders the key as a persistent sibling, not inside the swappable plate", async () => {
    render(await HomePage());

    const key = plateKey();

    expect(cartouche()).not.toContainElement(key);

    const plate = screen.getByRole("img", {
      name: /Dot map of [\d,]+ tracked sites/,
    });
    expect(plate).not.toContainElement(key);
  });

  // The key is a CORNER OVERLAY on the hero box, not a row in the hero's text
  // column. The invariant is DIRECT CHILDHOOD, not mere containment: the hero
  // box is the flex column, and `sm:mt-auto` claims free space only for a flex
  // ITEM of it. Wrap the key in any intermediate <div> and that wrapper — not
  // the key — becomes the flex item, so the auto margin resolves against the
  // wrapper's own content box, which has no slack, and the card stops moving
  // to the bottom edge. Same failure one level further out: left inside the
  // cartouche column the margin resolves against the column, and the card sits
  // wherever the copy ended. Both break the placement SILENTLY, with every
  // other test still green — hence `parentElement` is asserted by identity
  // rather than with the transitive `toContainElement`.
  //
  // What this test canNOT see: whether the card OVERLAPS the CTA row. jsdom
  // computes no layout, and the earlier `sm:absolute sm:bottom-4` version —
  // which did overlap it on any viewport under ~1,100px tall — satisfied
  // every assertion below. Containment is a precondition for the fix, not
  // evidence of it; the non-overlap guarantee comes from the card being in
  // flow, and is only observable in a browser.
  //
  // Asserted as DOM containment, never as a className string: a class
  // assertion cannot see nesting at all, and would keep passing for the wrong
  // reason the moment Tailwind's utilities or output change.
  it("hangs the key off the hero box, outside the text column", async () => {
    render(await HomePage());

    const key = plateKey();
    const column = cartouche().parentElement;
    expect(column).not.toBeNull();

    const heroBox = column?.parentElement ?? null;
    expect(heroBox).not.toBeNull();

    // Proves the ancestor walked to is really the hero box and not some outer
    // page wrapper: the hero box is the element holding BOTH the text column
    // and the plate. Without it, the identity check below would be pinning the
    // key to whatever element the walk happened to land on rather than to the
    // flex container `sm:mt-auto` actually resolves against.
    const plate = screen.getByRole("img", {
      name: /Dot map of [\d,]+ tracked sites/,
    });
    expect(heroBox).toContainElement(plate);

    expect(key.parentElement).toBe(heroBox);
    expect(column).not.toContainElement(key);

    // The MECHANISM, not just the precondition. Direct childhood is what makes
    // `sm:mt-auto` resolve against the hero box, but on its own it says nothing
    // about whether the box is a column flex container or whether the key still
    // asks to be pushed down. Strip `flex flex-col` — which the comment at
    // app/page.tsx:120-126 predicts someone will, as "unused" — and `sm:mt-auto`
    // goes inert, the card stops settling on the bottom edge, and the identity
    // check above still passes. Class assertions are the right tool for exactly
    // this half, for the same reason as the scrim's `absolute` and the hero
    // block's `relative`/`z-10` above.
    expect(heroBox).toHaveClass("flex");
    expect(heroBox).toHaveClass("flex-col");
    expect(key).toHaveClass("sm:mt-auto");
  });
});

/**
 * The "Notable sites" grid, whose cards carry the hover tilt.
 *
 * Its own describe because it needs `getNotableFacilities` to return something
 * — the shared beforeEach resolves it to `[]`, which is the right default for
 * every other block here (the grid disappears entirely and cannot interfere
 * with a page-wide query).
 */
describe("HomePage notable sites", () => {
  const NOTABLE = [
    {
      id: "alpha-site",
      name: "Alpha Site",
      operator: "Acme",
      status: "operational",
      facilityType: "data_center",
      location: { lat: 39.0438, lon: -77.4874, city: "Ashburn", state: "VA" },
      capacityMw: { operational: 120 },
    },
  ];

  // The tilt is wired by a class alone (`.plate-hover`, app/globals.css), so
  // deleting it from this card's className is a silent revert: the card looks
  // identical until a pointer enters it, and nothing else in this file
  // changes. jsdom has no `:hover`, applies no `@media` block and does no
  // compositing, so the class list is the only observable surface — the same
  // honest limit as the hero backing and `sm:mt-auto` assertions above. The
  // angle itself, and the clearance it has to fit inside, are pinned in
  // app/globals.css.test.ts.
  it("carries the plate-hover tilt on each notable-site card", async () => {
    mockGetNotableFacilities.mockResolvedValue(NOTABLE);

    render(await HomePage());

    const card = screen.getByRole("link", { name: /Alpha Site/ });
    expect(card).toHaveAttribute("href", "/facilities/alpha-site");
    expect(card).toHaveClass("plate-hover");
  });

  describe("record specimen", () => {
    const SPECIMEN = {
      id: "specimen-site",
      name: "Specimen Site",
      operator: "Specimen Energy",
      status: "under_construction",
      confidence: "reported",
      facilityType: "data_center",
      location: { lat: 39.3527, lon: -112.5777, city: "Delta", state: "UT" },
      capacityMw: { planned: 10000 },
      statusHistory: [
        { status: "proposed", date: "2025-06" },
        { status: "under_construction", date: "2025-12", sourceIndex: 0 },
      ],
      sources: [
        {
          url: "https://example.com/one",
          label: "First citation",
          publisher: "Example Wire",
          retrievedAt: "2026-07-06",
          kind: "press",
        },
        {
          url: "https://example.com/two",
          label: "Second citation",
          retrievedAt: "2026-07-07",
          kind: "permit",
        },
        {
          url: "https://example.com/three",
          label: "Third citation",
          publisher: "Example Register",
          retrievedAt: "2026-08-25",
          kind: "filing",
        },
      ],
      lastUpdated: "2026-08-25",
    };

    it("renders the pinned record with its citations, under the same heading", async () => {
      mockGetNotableFacilities.mockResolvedValue([SPECIMEN, ...NOTABLE]);
      mockSelectRecordSpecimen.mockReturnValue(SPECIMEN);

      render(await HomePage());

      expect(
        screen.getByRole("heading", { name: "Notable sites" })
      ).toBeInTheDocument();
      const citations = screen.getByRole("list", { name: "Cited sources" });
      expect(within(citations).getAllByRole("link")).toHaveLength(3);
      // The caption reads the LIVE count from getStats, not a snapshot literal.
      // 2,412 is the mock's synthetic figure and appears nowhere in the source,
      // so this fails if the call site ever reverts to `count={1929}` — which
      // it could not do while the fixture agreed with the copy.
      expect(
        screen.getByText("One of 2,412. Every field traces to a citation.")
      ).toBeInTheDocument();
      // And the figure the copy was written against is not on the page at all.
      expect(screen.queryByText(/One of 1,929/)).not.toBeInTheDocument();
    });

    it("does not print the specimen a second time as a compact card", async () => {
      mockGetNotableFacilities.mockResolvedValue([SPECIMEN, ...NOTABLE]);
      mockSelectRecordSpecimen.mockReturnValue(SPECIMEN);

      render(await HomePage());

      // One link to the specimen's page — the record's own title — and no
      // duplicate card beneath it.
      expect(
        screen.getAllByRole("link", { name: /Specimen Site/ })
      ).toHaveLength(1);
      expect(
        screen.getByRole("link", { name: /Alpha Site/ })
      ).toBeInTheDocument();
    });

    // The other arm of `specimenCards`: `getNotableFacilities` returns 6 by
    // capacity, and the specimen is picked by a DIFFERENT rule (sources +
    // history + capacity), so it is not always one of them. When it is, the
    // filter leaves 5; when it is not, the filter removes nothing and the
    // `.slice(0, 5)` is what holds the row count at 5. Nothing else in the
    // file exercises that slice — with only the filter, this render would put
    // 6 cards under the specimen.
    it("still shows exactly five cards when the specimen is not among the notable six", async () => {
      const SIX = Array.from({ length: 6 }, (_, i) => ({
        id: `notable-${i + 1}`,
        name: `Notable ${i + 1}`,
        operator: "Acme",
        status: "operational",
        facilityType: "data_center",
        location: { lat: 39.0438, lon: -77.4874, city: "Ashburn", state: "VA" },
        capacityMw: { operational: 600 - i * 100 },
      }));
      mockGetNotableFacilities.mockResolvedValue(SIX);
      mockSelectRecordSpecimen.mockReturnValue(SPECIMEN);

      render(await HomePage());

      expect(screen.getAllByRole("link", { name: /Notable [1-6]/ })).toHaveLength(5);
      // The one dropped is the LAST by capacity, not an arbitrary member: the
      // five highest are all still on the page.
      for (const n of [1, 2, 3, 4, 5]) {
        expect(
          screen.getByRole("link", { name: new RegExp(`Notable ${n}`) })
        ).toHaveAttribute("href", `/facilities/notable-${n}`);
      }
      expect(
        screen.queryByRole("link", { name: /Notable 6/ })
      ).not.toBeInTheDocument();
      // And the specimen is still the record shown at full fidelity above them.
      expect(
        screen.getByRole("list", { name: "Cited sources" })
      ).toBeInTheDocument();
    });

    // The degraded path: an empty dataset or a local render with no
    // DATABASE_URL, where selectRecordSpecimen finds no qualifying record.
    it("falls back to the cards alone when no record clears the bar", async () => {
      mockGetNotableFacilities.mockResolvedValue(NOTABLE);
      mockSelectRecordSpecimen.mockReturnValue(null);

      render(await HomePage());

      expect(
        screen.getByRole("heading", { name: "Notable sites" })
      ).toBeInTheDocument();
      // Still at least one card — what e2e/home.spec.ts asserts is visible.
      expect(screen.getByRole("link", { name: /Alpha Site/ })).toHaveAttribute(
        "href",
        "/facilities/alpha-site"
      );
      expect(
        screen.queryByRole("list", { name: "Cited sources" })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Every field traces to a citation/)
      ).not.toBeInTheDocument();
    });
  });
});
