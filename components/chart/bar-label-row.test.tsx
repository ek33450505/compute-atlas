import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { BarLabelRow } from "./bar-label-row";

describe("BarLabelRow", () => {
  it("renders the label and the value in two columns", () => {
    render(<BarLabelRow label="Data center" valueLabel="12 · 40%" />);

    expect(screen.getByText("Data center")).toBeInTheDocument();
    expect(screen.getByText("12 · 40%")).toBeInTheDocument();
  });

  it("accepts a composed ReactNode on either side, not just strings", () => {
    render(
      <BarLabelRow
        label={<strong>Litigation</strong>}
        valueLabel={
          <>
            <span>4</span> of <span>10</span>
          </>
        }
      />
    );

    expect(screen.getByText("Litigation")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("of")).toBeInTheDocument();
  });

  it("keeps the value column present but empty when no value is given, rather than collapsing it", () => {
    // `PercentageBar` has always emitted the span unconditionally; preserving
    // that is what lets both callers share one markup path with no flag.
    const { container } = render(<BarLabelRow label="X" valueLabel={undefined} />);

    const value = container.querySelector(".font-mono");
    expect(value).not.toBeNull();
    expect(value?.textContent).toBe("");
  });

  /**
   * Pinned verbatim, not asserted by class fragment. This row is shared by
   * `PercentageBar` (six routes: /states/[state], /operators/[operator],
   * /opposition, /power, /stats, /gaps) and `StackedBand`, and it was
   * extracted on the promise that its output is byte-identical to the inline
   * markup it replaced. A behavioral assertion cannot keep that promise —
   * only the exact string can. If this fails, the extraction has drifted and
   * every one of those routes moved with it.
   */
  it("emits exactly the markup both callers previously inlined", () => {
    const { container } = render(
      <BarLabelRow label="Data center" valueLabel="12 · 40%" />
    );

    expect(container.innerHTML).toBe(
      '<div class="flex items-baseline justify-between gap-2 text-sm">' +
        '<span class="text-foreground">Data center</span>' +
        '<span class="font-mono tabular-nums text-muted-foreground">12 · 40%</span>' +
        "</div>"
    );
  });
});
