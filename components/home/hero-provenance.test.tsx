import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { HeroProvenance } from "./hero-provenance";

const BASE_PROPS = {
  sites: 1929,
  stateCodes: ["CA", "TX", "VA", "DC"],
  sources: 8421,
  newThisQuarter: 0,
  cancelledThisQuarter: 0,
};

describe("HeroProvenance", () => {
  it("renders the live counts and the jurisdiction phrase", () => {
    render(<HeroProvenance {...BASE_PROPS} />);

    expect(
      screen.getByText(
        "1,929 sites · 3 states and DC · 8,421 sources"
      )
    ).toBeInTheDocument();
  });

  it("carries no edition date and never says `updated`", () => {
    const { container } = render(<HeroProvenance {...BASE_PROPS} />);

    expect(container.textContent).not.toContain("edition");
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
        "1,929 sites · 3 states and DC · 8,421 sources · static map omits 9 in U.S. territories"
      )
    ).toBeInTheDocument();
  });

  it("keeps the omission after the quarter when both are present", () => {
    render(
      <HeroProvenance {...BASE_PROPS} newThisQuarter={41} mapOmitted={9} />
    );

    expect(
      screen.getByText(
        "1,929 sites · 3 states and DC · 8,421 sources · +41 new this quarter · static map omits 9 in U.S. territories"
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

  // Formatter gap: every other mapOmitted case here is a single digit, so the
  // `toLocaleString("en-US")` call was doing nothing observable and a plain
  // `${mapOmitted}` would have passed all of them. Four digits is the smallest
  // input where the grouping separator appears, so this is the assertion that
  // actually pins the formatter rather than the number.
  it("groups a four-digit omission count with a thousands separator", () => {
    const { container } = render(
      <HeroProvenance {...BASE_PROPS} mapOmitted={1000} />
    );

    expect(container.textContent).toContain(
      "static map omits 1,000 in U.S. territories"
    );
    // Guards the separator specifically: an unformatted `1000` would still
    // satisfy a looser substring check on the surrounding prose.
    expect(container.textContent).not.toContain("omits 1000 ");
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
