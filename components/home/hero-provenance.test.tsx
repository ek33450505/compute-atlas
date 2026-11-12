import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { HeroProvenance } from "./hero-provenance";

const BASE_PROPS = {
  sites: "1,929 sites, counted on 12 November 2026",
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
        "1,929 sites, counted on 12 November 2026 · 3 states and DC · 8,421 sources"
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

  // The static-map territory omission moved to <PlateKey>, beside the plot it qualifies.
  // Its removal from this line is asserted here so it cannot drift back into two places.
  it("no longer carries the static-map territory caveat", () => {
    const { container } = render(<HeroProvenance {...BASE_PROPS} newThisQuarter={41} />);

    expect(container.textContent).not.toContain("static map");
    expect(container.textContent).not.toContain("omits");
  });

  // A count without a date is the bug this unit removes: when the read failed
  // (sites === null) the segment is dropped, never printed undated.
  it("drops the site count when its read failed", () => {
    render(<HeroProvenance {...BASE_PROPS} sites={null} />);

    expect(screen.getByText("3 states and DC · 8,421 sources")).toBeInTheDocument();
  });

  it("always shows the as-of date with the site count", () => {
    const { container } = render(<HeroProvenance {...BASE_PROPS} />);

    expect(container.textContent).toContain("sites, counted on 12 November 2026");
  });

  it("thousands-separates the source count", () => {
    render(<HeroProvenance {...BASE_PROPS} sources={101112} />);

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
