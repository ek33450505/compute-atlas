import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MapLegend } from "./map-legend";

// ---------------------------------------------------------------------------
// Helpers — viewport mock. Mirrors the window.matchMedia stub in
// vitest.setup.ts, with a configurable `matches` so tests can force a wide
// (≥640px) or narrow (<640px) viewport for MapLegend's responsive check.
// ---------------------------------------------------------------------------

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("MapLegend — wide viewport (≥640px)", () => {
  beforeEach(() => mockMatchMedia(true));

  it("renders all 5 status labels", () => {
    render(<MapLegend />);
    expect(screen.getByText("Operational")).toBeInTheDocument();
    expect(screen.getByText("Under construction")).toBeInTheDocument();
    expect(screen.getByText("Permitted")).toBeInTheDocument();
    expect(screen.getByText("Proposed")).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("has an accessible region name", () => {
    render(<MapLegend />);
    expect(
      screen.getByRole("region", { name: /key to symbols/i })
    ).toBeInTheDocument();
  });

  it("renders all facility-type labels", () => {
    render(<MapLegend />);
    expect(screen.getByText("Data center")).toBeInTheDocument();
    expect(screen.getByText("Crypto mining")).toBeInTheDocument();
    expect(screen.getByText("Power generation")).toBeInTheDocument();
  });

  it("does not render the collapsed toggle chip", () => {
    render(<MapLegend />);
    expect(
      screen.queryByRole("button", { name: /map key/i })
    ).not.toBeInTheDocument();
  });
});

describe("MapLegend — narrow viewport (<640px)", () => {
  beforeEach(() => mockMatchMedia(false));

  it("renders a collapsed toggle chip instead of the full panel", () => {
    render(<MapLegend />);
    expect(
      screen.getByRole("button", { name: "Show map key" })
    ).toBeInTheDocument();
    expect(screen.queryByText("Operational")).not.toBeInTheDocument();
  });

  it("still exposes the accessible region name on the outer container", () => {
    render(<MapLegend />);
    expect(
      screen.getByRole("region", { name: /key to symbols/i })
    ).toBeInTheDocument();
  });

  it("expands the full panel when the chip is tapped", async () => {
    const user = userEvent.setup();
    render(<MapLegend />);

    await user.click(screen.getByRole("button", { name: "Show map key" }));

    const toggle = screen.getByRole("button", { name: "Hide map key" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Operational")).toBeInTheDocument();
    expect(screen.getByText("Data center")).toBeInTheDocument();
  });

  it("collapses the panel again on a second tap", async () => {
    const user = userEvent.setup();
    render(<MapLegend />);

    await user.click(screen.getByRole("button", { name: "Show map key" }));
    await user.click(screen.getByRole("button", { name: "Hide map key" }));

    expect(
      screen.getByRole("button", { name: "Show map key" })
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Operational")).not.toBeInTheDocument();
  });
});
