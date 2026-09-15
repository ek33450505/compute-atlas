import { describe, it, expect, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { HeroProvenance, formatEditionDate } from "./hero-provenance";

const BASE_PROPS = {
  sites: 1929,
  stateCodes: ["CA", "TX", "VA", "DC"],
  sources: 8421,
  editionAsOf: "2026-09-15T00:00:00.000Z",
  newThisQuarter: 0,
  cancelledThisQuarter: 0,
};

describe("formatEditionDate", () => {
  it("formats an ISO timestamp as `15 Sep 2026`", () => {
    expect(formatEditionDate("2026-09-15T00:00:00.000Z")).toBe("15 Sep 2026");
  });

  it("formats a date-only ISO string the same way", () => {
    expect(formatEditionDate("2026-01-05")).toBe("5 Jan 2026");
  });

  // Determinism guard: the whole reason this helper exists instead of
  // `toLocaleDateString()` is that a locale-less call resolves against the
  // host default, which differs between the Node test runner and a browser.
  //
  // ⚠️ Pinning TZ is what makes this test able to fail. The mutation
  // (getUTCDate/getUTCMonth/getUTCFullYear → getDate/getMonth/getFullYear)
  // SURVIVES both stamps under TZ=UTC, which is what CI runs — so an
  // unpinned assertion here is a permanent false green. The two directions
  // are also asymmetric and each needs its own stamp:
  //   · a midnight stamp rolls BACK to the 14th in zones behind UTC
  //     (America/New_York, Pacific/Midway)
  //   · a 23:00 stamp rolls FORWARD to the 16th in zones ahead of UTC
  //     (Asia/Tokyo, Pacific/Kiritimati)
  // Neither stamp alone catches both, hence the full TZ × stamp matrix.
  describe("is stable across host timezones", () => {
    const ORIGINAL_TZ = process.env.TZ;

    afterEach(() => {
      // Restore so no later test in this file (or suite) inherits a mutated
      // timezone. `delete` is the correct restore when TZ was never set.
      if (ORIGINAL_TZ === undefined) delete process.env.TZ;
      else process.env.TZ = ORIGINAL_TZ;
    });

    // `expectedLocalDate` asserts the PRECONDITION: that Node actually
    // re-read process.env.TZ. Without it, a runtime that stopped honouring
    // a mid-process TZ change would silently degrade this whole matrix back
    // into the UTC no-op it replaced — passing vacuously instead of failing.
    const CASES = [
      { tz: "UTC", stamp: "2026-09-15T00:00:00.000Z", expectedLocalDate: 15 },
      { tz: "UTC", stamp: "2026-09-15T23:00:00.000Z", expectedLocalDate: 15 },
      {
        tz: "America/New_York",
        stamp: "2026-09-15T00:00:00.000Z",
        expectedLocalDate: 14,
      },
      {
        tz: "America/New_York",
        stamp: "2026-09-15T23:00:00.000Z",
        expectedLocalDate: 15,
      },
      { tz: "Asia/Tokyo", stamp: "2026-09-15T00:00:00.000Z", expectedLocalDate: 15 },
      { tz: "Asia/Tokyo", stamp: "2026-09-15T23:00:00.000Z", expectedLocalDate: 16 },
    ] as const;

    for (const { tz, stamp, expectedLocalDate } of CASES) {
      it(`formats ${stamp} as \`15 Sep 2026\` under TZ=${tz}`, () => {
        process.env.TZ = tz;

        expect(new Date(stamp).getDate()).toBe(expectedLocalDate);
        expect(formatEditionDate(stamp)).toBe("15 Sep 2026");
      });
    }
  });

  it("formats a year-end date without rolling the year", () => {
    expect(formatEditionDate("2026-12-31T00:00:00.000Z")).toBe("31 Dec 2026");
  });

  it("passes an unparseable value through rather than rendering Invalid Date", () => {
    // `getDatasetEdition()` falls back to the literal string "unknown" when
    // facilities.meta.json is malformed.
    expect(formatEditionDate("unknown")).toBe("unknown");
  });
});

describe("HeroProvenance", () => {
  it("renders the live counts, the jurisdiction phrase and the edition date", () => {
    render(<HeroProvenance {...BASE_PROPS} />);

    expect(
      screen.getByText(
        "1,929 sites · 3 states and DC · 8,421 sources · edition 15 Sep 2026"
      )
    ).toBeInTheDocument();
  });

  it("labels the date `edition`, never `updated`", () => {
    // edition.asOf describes the last published SNAPSHOT export, not the live
    // dataset (Neon moves ahead of it between publishes). Calling it "updated"
    // would assert the live data is only as fresh as the snapshot.
    const { container } = render(<HeroProvenance {...BASE_PROPS} />);

    expect(container.textContent).toContain("edition");
    expect(container.textContent).not.toContain("updated");
    expect(container.textContent).not.toContain("Updated");
  });

  it("omits the quarter segment when nothing moved this quarter", () => {
    const { container } = render(<HeroProvenance {...BASE_PROPS} />);

    expect(container.textContent).not.toContain("this quarter");
    expect(container.textContent).not.toContain("+0");
  });

  it("renders only the new count when nothing was cancelled", () => {
    render(<HeroProvenance {...BASE_PROPS} newThisQuarter={41} />);

    expect(screen.getByText(/\+41 new this quarter/)).toBeInTheDocument();
    expect(screen.queryByText(/cancelled/)).not.toBeInTheDocument();
  });

  it("renders the cancelled count alongside the new count when both moved", () => {
    render(
      <HeroProvenance
        {...BASE_PROPS}
        newThisQuarter={41}
        cancelledThisQuarter={3}
      />
    );

    expect(
      screen.getByText(/\+41 new this quarter, 3 cancelled/)
    ).toBeInTheDocument();
  });

  // "+0 new this quarter, 2 cancelled" states a finding ("nothing was added")
  // that the data does not support — it is the same absence the both-zero case
  // omits, with a real fact bolted on. Only the cancellations are rendered.
  it("renders the cancellations alone when nothing new moved", () => {
    const { container } = render(
      <HeroProvenance {...BASE_PROPS} cancelledThisQuarter={2} />
    );

    expect(screen.getByText(/2 cancelled this quarter/)).toBeInTheDocument();
    expect(container.textContent).not.toContain("+0");
    expect(container.textContent).not.toContain("new this quarter");
  });

  // The hero plate discloses this in its accessible name too, but that element
  // is swapped out for the (aria-hidden) globe the moment MapLibre mounts, so
  // on desktop the disclosure came and went with the mount. This rule is on
  // the page at every viewport in every state — asserting the WHOLE line also
  // pins that the segment joins the same single interpolated string as the
  // rest (the repo's remedy for the JSX entity-swallows-a-leading-space bug),
  // not an adjacent JSX child.
  it("discloses what the static map cannot place, as the last segment", () => {
    render(<HeroProvenance {...BASE_PROPS} mapOmitted={9} />);

    expect(
      screen.getByText(
        "1,929 sites · 3 states and DC · 8,421 sources · edition 15 Sep 2026 · static map omits 9 in U.S. territories"
      )
    ).toBeInTheDocument();
  });

  it("keeps the omission after the quarter when both are present", () => {
    render(
      <HeroProvenance {...BASE_PROPS} newThisQuarter={41} mapOmitted={9} />
    );

    expect(
      screen.getByText(
        "1,929 sites · 3 states and DC · 8,421 sources · edition 15 Sep 2026 · +41 new this quarter · static map omits 9 in U.S. territories"
      )
    ).toBeInTheDocument();
  });

  it("says `a U.S. territory` when exactly one site is unplaceable", () => {
    const { container } = render(
      <HeroProvenance {...BASE_PROPS} mapOmitted={1} />
    );

    expect(container.textContent).toContain(
      "static map omits 1 in a U.S. territory"
    );
    expect(container.textContent).not.toContain("territories");
  });

  // Same reasoning as the quarter segment above: an absence is not a finding.
  it.each([
    ["nothing is omitted", 0],
    ["the caller does not know", undefined],
  ])("drops the segment entirely when %s", (_case, mapOmitted) => {
    const { container } = render(
      <HeroProvenance {...BASE_PROPS} mapOmitted={mapOmitted} />
    );

    expect(container.textContent).not.toContain("static map");
    expect(container.textContent).not.toContain("omits");
  });

  it("thousands-separates large figures", () => {
    render(
      <HeroProvenance {...BASE_PROPS} sites={12345} sources={101112} />
    );

    expect(screen.getByText(/12,345 sites/)).toBeInTheDocument();
    expect(screen.getByText(/101,112 sources/)).toBeInTheDocument();
  });

  it("merges an extra className onto the mono rule", () => {
    const { container } = render(
      <HeroProvenance {...BASE_PROPS} className="mt-6" />
    );

    const line = container.querySelector("p");
    expect(line).toHaveClass("mt-6");
    expect(line).toHaveClass("font-mono");
    expect(line).toHaveClass("tabular-nums");
  });
});
