import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MapLegend } from "./map-legend";

// ---------------------------------------------------------------------------
// MapLegend now collapses to a "⌖ Key" toggle chip by default on every
// viewport (desktop included) — it only expands into the full status/type
// panel on click. There is no longer a viewport-based branch to mock.
// ---------------------------------------------------------------------------

describe("MapLegend", () => {
  it("renders the collapsed toggle chip by default", () => {
    render(<MapLegend />);
    const toggle = screen.getByRole("button", { name: "Show map key" });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("does not render status or type entries before expanding", () => {
    render(<MapLegend />);
    expect(screen.queryByText("Operational")).not.toBeInTheDocument();
    expect(screen.queryByText("Data center")).not.toBeInTheDocument();
  });

  it("still exposes the accessible region name on the outer container", () => {
    render(<MapLegend />);
    expect(
      screen.getByRole("region", { name: /key to symbols/i })
    ).toBeInTheDocument();
  });

  it("expands the full panel when the chip is clicked, showing all 5 status labels and all facility types", async () => {
    const user = userEvent.setup();
    render(<MapLegend />);

    await user.click(screen.getByRole("button", { name: "Show map key" }));

    const toggle = screen.getByRole("button", { name: "Hide map key" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    expect(screen.getByText("Operational")).toBeInTheDocument();
    expect(screen.getByText("Under construction")).toBeInTheDocument();
    expect(screen.getByText("Permitted")).toBeInTheDocument();
    expect(screen.getByText("Proposed")).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();

    expect(screen.getByText("Data center")).toBeInTheDocument();
    expect(screen.getByText("Crypto mining")).toBeInTheDocument();
    expect(screen.getByText("Power generation")).toBeInTheDocument();
  });

  it("collapses the panel again on a second click", async () => {
    const user = userEvent.setup();
    render(<MapLegend />);

    await user.click(screen.getByRole("button", { name: "Show map key" }));
    await user.click(screen.getByRole("button", { name: "Hide map key" }));

    const toggle = screen.getByRole("button", { name: "Show map key" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Operational")).not.toBeInTheDocument();
  });
});
