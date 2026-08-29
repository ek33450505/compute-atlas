import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MapLayerControl } from "./map-layer-control";
import mapLayers from "@/public/data/map-layers.json";

// Legend counts are build-time output of `npm run build:mapdata`, so they shift
// whenever the dataset changes. Derive them rather than hardcoding, or every
// data wave re-breaks this file (it did: 126 -> 130 in 8c1f754).
const WATER_STRESS_EXTREME = String(
  mapLayers.waterStress.distribution["Extremely High (>80%)"]
);
const GROUNDWATER_HIGH = String(
  mapLayers.groundwaterDecline.distribution["High (4-8 cm/y)"]
);

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
    isSatellite: boolean;
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
      isSatellite={overrides.isSatellite ?? false}
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

  it("renders the water-stress legend with band labels and facility counts when the layer is on", async () => {
    const user = userEvent.setup();
    renderControl({ showWaterStress: true });

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));

    expect(screen.getByText("Extremely High (>80%)")).toBeInTheDocument();
    expect(screen.getByText(WATER_STRESS_EXTREME)).toBeInTheDocument();
  });

  it("renders the groundwater-decline legend with band labels and facility counts when the layer is on", async () => {
    const user = userEvent.setup();
    renderControl({ showGroundwater: true });

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));

    expect(screen.getByText("High (4-8 cm/y)")).toBeInTheDocument();
    expect(screen.getByText(GROUNDWATER_HIGH)).toBeInTheDocument();
  });

  it("does not render legends when their layers are off", async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));

    expect(screen.queryByText("Extremely High (>80%)")).not.toBeInTheDocument();
    expect(screen.queryByText("High (4-8 cm/y)")).not.toBeInTheDocument();
  });

  it("renders a key-only drought legend with no facility counts when drought is on", async () => {
    const user = userEvent.setup();
    renderControl({ showDrought: true });

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));

    expect(screen.getByText("D4 — Exceptional")).toBeInTheDocument();
    expect(screen.getByText("D0 — Abnormally Dry")).toBeInTheDocument();
    // Drought has no per-facility distribution counts anywhere in the panel.
    expect(screen.queryByText(WATER_STRESS_EXTREME)).not.toBeInTheDocument();
  });

  it("disables the three fill-only toggles and shows a hint when isSatellite is true, leaving the others enabled", async () => {
    const user = userEvent.setup();
    renderControl({ isSatellite: true });

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));

    const waterStress = screen.getByLabelText("Baseline water stress") as HTMLInputElement;
    const groundwater = screen.getByLabelText("Groundwater decline") as HTMLInputElement;
    const drought = screen.getByLabelText("Drought") as HTMLInputElement;
    expect(waterStress).toBeDisabled();
    expect(groundwater).toBeDisabled();
    expect(drought).toBeDisabled();

    const hints = screen.getAllByText("shown on standard basemap only");
    expect(hints).toHaveLength(3);

    const waterways = screen.getByLabelText("Waterways") as HTMLInputElement;
    const power = screen.getByLabelText("Transmission (≥230 kV)") as HTMLInputElement;
    const aquifers = screen.getByLabelText("Aquifers") as HTMLInputElement;
    expect(waterways).not.toBeDisabled();
    expect(power).not.toBeDisabled();
    expect(aquifers).not.toBeDisabled();
  });

  it("does not disable the fill-only toggles when isSatellite is false", async () => {
    const user = userEvent.setup();
    renderControl({ isSatellite: false });

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));

    expect(screen.getByLabelText("Baseline water stress")).not.toBeDisabled();
    expect(screen.queryByText("shown on standard basemap only")).not.toBeInTheDocument();
  });

  it("closes the panel and returns focus to the toggle button on Escape", async () => {
    const user = userEvent.setup();
    renderControl();

    const openButton = screen.getByRole("button", { name: "Show map layers panel" });
    await user.click(openButton);
    expect(screen.getByRole("button", { name: "Hide map layers panel" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );

    await user.keyboard("{Escape}");

    const closedButton = screen.getByRole("button", { name: "Show map layers panel" });
    expect(closedButton).toHaveAttribute("aria-expanded", "false");
    expect(closedButton).toHaveFocus();
  });

  it("does not cap its own scroll height — no local overflow/max-height, so the ancestor Tools panel is the single scroll container", async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));

    const heading = screen.getByText("Optional layers");
    const panelContent = heading.parentElement as HTMLElement;
    expect(panelContent).not.toBeNull();
    // Regression guard: this panel used to measure its own top offset and
    // cap an inline maxHeight against the viewport. Once it started
    // rendering inside #map-tools-panel (itself a viewport-capped scroll
    // container in FacilityMap), two independently viewport-relative caps
    // nested inside one another could compute this panel's cap to 0 on a
    // short viewport while the ancestor's cap was still positive — the
    // panel sat in the DOM but was entirely invisible, with no scrollbar to
    // reveal it. Rendering at natural height with no local overflow/height
    // styling makes that impossible structurally.
    expect(panelContent.className).not.toContain("overflow-y-auto");
    expect(panelContent.className).not.toMatch(/max-h(-|\[)/);
    expect(panelContent.getAttribute("style")).toBeNull();
  });

  it("leaves the panel mounted at natural height across viewport-height changes, with no inline maxHeight ever applied", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(320);

    renderControl();
    await user.click(screen.getByRole("button", { name: "Show map layers panel" }));

    expect(screen.getByText("Optional layers")).toBeInTheDocument();
    expect(screen.getByText("Water")).toBeInTheDocument();
    expect(screen.getByText("Geology")).toBeInTheDocument();
    const heading = screen.getByText("Optional layers");
    expect((heading.parentElement as HTMLElement).getAttribute("style")).toBeNull();

    vi.restoreAllMocks();
  });
});
