import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MapLayerControl } from "./map-layer-control";

function makeSetters() {
  return {
    onToggleWater: vi.fn(),
    onTogglePower: vi.fn(),
    onToggleDrought: vi.fn(),
  };
}

function renderControl(
  overrides: Partial<{ showWater: boolean; showPower: boolean; showDrought: boolean }> = {},
  setters = makeSetters()
) {
  render(
    <MapLayerControl
      showWater={overrides.showWater ?? false}
      onToggleWater={setters.onToggleWater}
      showPower={overrides.showPower ?? false}
      onTogglePower={setters.onTogglePower}
      showDrought={overrides.showDrought ?? false}
      onToggleDrought={setters.onToggleDrought}
    />
  );
  return setters;
}

describe("MapLayerControl", () => {
  it("renders collapsed by default as an icon-only 'show layers' toggle button", () => {
    renderControl();
    const toggle = screen.getByRole("button", { name: "Show map layers panel" });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("title", "Map layers");
    expect(screen.queryByText("Layers")).not.toBeInTheDocument();
    expect(screen.queryByText("Waterways")).not.toBeInTheDocument();
  });

  it("expands the panel with three labeled toggles on click", async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));

    const toggle = screen.getByRole("button", { name: "Hide map layers panel" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    expect(screen.getByLabelText("Waterways")).toBeInTheDocument();
    expect(screen.getByLabelText("Transmission (≥230 kV)")).toBeInTheDocument();
    expect(screen.getByLabelText("Drought")).toBeInTheDocument();
  });

  it("collapses the panel again on a second click", async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));
    await user.click(screen.getByRole("button", { name: "Hide map layers panel" }));

    expect(
      screen.getByRole("button", { name: "Show map layers panel" })
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Waterways")).not.toBeInTheDocument();
  });

  it("calls the matching setter when a toggle is clicked, and reflects checked state via props", async () => {
    const user = userEvent.setup();
    const setters = renderControl({ showWater: false });

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));
    const waterToggle = screen.getByLabelText("Waterways") as HTMLInputElement;
    expect(waterToggle.checked).toBe(false);

    await user.click(waterToggle);
    expect(setters.onToggleWater).toHaveBeenCalledTimes(1);
  });

  it("renders a pre-checked toggle when its layer is already on", async () => {
    const user = userEvent.setup();
    renderControl({ showPower: true });

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));
    const powerToggle = screen.getByLabelText("Transmission (≥230 kV)") as HTMLInputElement;
    expect(powerToggle.checked).toBe(true);
  });

  it("shows a per-layer attribution caption in the panel only when a layer is on", async () => {
    const user = userEvent.setup();
    renderControl({ showDrought: true });

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));
    expect(screen.getByText(/Drought as of/)).toBeInTheDocument();
    expect(screen.queryByText(/^Water:/)).not.toBeInTheDocument();
  });

  it("shows no attribution caption when all layers are off", async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));
    expect(screen.queryByText(/Drought as of/)).not.toBeInTheDocument();
  });
});
