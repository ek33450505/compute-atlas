import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MapLayerControl } from "./map-layer-control";

function makeSetters() {
  return {
    onToggleWater: vi.fn(),
    onTogglePower: vi.fn(),
    onToggleDrought: vi.fn(),
    onToggleWaterStress: vi.fn(),
    onToggleGroundwater: vi.fn(),
    onToggleAquifers: vi.fn(),
  };
}

function renderControl(
  overrides: Partial<{
    showWater: boolean;
    showPower: boolean;
    showDrought: boolean;
    showWaterStress: boolean;
    showGroundwater: boolean;
    showAquifers: boolean;
  }> = {},
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
      showWaterStress={overrides.showWaterStress ?? false}
      onToggleWaterStress={setters.onToggleWaterStress}
      showGroundwater={overrides.showGroundwater ?? false}
      onToggleGroundwater={setters.onToggleGroundwater}
      showAquifers={overrides.showAquifers ?? false}
      onToggleAquifers={setters.onToggleAquifers}
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

  it("expands the panel with the grouped section headers on click", async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));

    const toggle = screen.getByRole("button", { name: "Hide map layers panel" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    expect(screen.getByText("Water")).toBeInTheDocument();
    expect(screen.getByText("Power")).toBeInTheDocument();
    expect(screen.getByText("Geology")).toBeInTheDocument();
  });

  it("renders all six labeled toggles across the groups", async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));

    expect(screen.getByLabelText("Waterways")).toBeInTheDocument();
    expect(screen.getByLabelText("Baseline water stress")).toBeInTheDocument();
    expect(screen.getByLabelText("Groundwater decline")).toBeInTheDocument();
    expect(screen.getByLabelText("Drought")).toBeInTheDocument();
    expect(screen.getByLabelText("Transmission (≥230 kV)")).toBeInTheDocument();
    expect(screen.getByLabelText("Aquifers")).toBeInTheDocument();
  });

  it("renders a color swatch accompanying every toggle", async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));

    const labels = [
      "Waterways",
      "Baseline water stress",
      "Groundwater decline",
      "Drought",
      "Transmission (≥230 kV)",
      "Aquifers",
    ];
    for (const labelText of labels) {
      const input = screen.getByLabelText(labelText);
      const label = input.closest("label");
      expect(label).not.toBeNull();
      const swatch = label!.querySelector('span[aria-hidden="true"]');
      expect(swatch).toBeInTheDocument();
      expect(swatch).toHaveStyle({ backgroundColor: expect.any(String) });
    }
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

  it.each([
    ["Baseline water stress", "onToggleWaterStress"] as const,
    ["Groundwater decline", "onToggleGroundwater"] as const,
    ["Aquifers", "onToggleAquifers"] as const,
  ])("fires %s's handler when its checkbox is toggled", async (labelText, handlerKey) => {
    const user = userEvent.setup();
    const setters = renderControl();

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));
    await user.click(screen.getByLabelText(labelText));

    expect(setters[handlerKey]).toHaveBeenCalledTimes(1);
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

  it("shows the new-layer attributions when those layers are active", async () => {
    const user = userEvent.setup();
    renderControl({ showWaterStress: true, showGroundwater: true, showAquifers: true });

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));
    expect(screen.getByText(/Water stress: WRI Aqueduct 4\.0/)).toBeInTheDocument();
    expect(screen.getByText(/Groundwater: WRI Aqueduct 4\.0/)).toBeInTheDocument();
    expect(screen.getByText(/Aquifers: USGS Principal Aquifers/)).toBeInTheDocument();
  });

  it("shows no attribution caption when all layers are off", async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));
    expect(screen.queryByText(/Drought as of/)).not.toBeInTheDocument();
  });
});
