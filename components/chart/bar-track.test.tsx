import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { BarTrack } from "./bar-track";

describe("BarTrack", () => {
  it("renders an unroled, unnamed rail by default — the ground under PercentageBar's fill", () => {
    const { container } = render(
      <BarTrack>
        <div aria-hidden="true" data-fill />
      </BarTrack>
    );

    const rail = container.firstElementChild as HTMLElement;
    expect(rail.tagName).toBe("DIV");
    expect(rail).not.toHaveAttribute("role");
    expect(rail).not.toHaveAttribute("aria-label");
    expect(rail).toHaveClass("h-1.5", "w-full", "overflow-hidden", "rounded-full", "bg-muted");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("becomes a named graphic when it IS the picture", () => {
    render(
      <BarTrack role="img" ariaLabel="Baseline water stress, most severe band first.">
        <div aria-hidden="true" />
      </BarTrack>
    );

    expect(
      screen.getByRole("img", { name: "Baseline water stress, most severe band first." })
    ).toBeInTheDocument();
  });

  it("lets a caller replace the default height via tailwind-merge rather than fighting it", () => {
    const { container } = render(
      <BarTrack className="mt-1.5 flex h-2.5">
        <div aria-hidden="true" />
      </BarTrack>
    );

    const rail = container.firstElementChild as HTMLElement;
    expect(rail).toHaveClass("h-2.5", "flex", "mt-1.5");
    expect(rail.className).not.toContain("h-1.5");
  });

  /**
   * A type-level assertion, checked by `npm run typecheck`, not at runtime:
   * `role="img"` with no accessible name is announced as an unlabelled
   * graphic, so the props are a discriminated union that refuses to let the
   * two be separated. `@ts-expect-error` is self-falsifying — if the union
   * is ever loosened back into two independent optionals, these stop erroring
   * and tsc fails on the unused directive.
   */
  it("refuses, at the type level, to let role and accessible name be separated", () => {
    const roleWithoutName = (
      // @ts-expect-error role="img" requires ariaLabel
      <BarTrack role="img">
        <div aria-hidden="true" />
      </BarTrack>
    );
    const nameWithoutRole = (
      // @ts-expect-error ariaLabel is meaningless without role="img"
      <BarTrack ariaLabel="orphaned name">
        <div aria-hidden="true" />
      </BarTrack>
    );

    // Rendering them is incidental; the assertion above is the test. Kept so
    // the variables are used and the case is not silently empty.
    expect(roleWithoutName).toBeTruthy();
    expect(nameWithoutRole).toBeTruthy();
  });
});
