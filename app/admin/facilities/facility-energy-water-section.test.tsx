import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FacilityEnergyWaterSection } from "./facility-energy-water-section";

describe("FacilityEnergyWaterSection", () => {
  it("renders energy and water fields with their current values", () => {
    render(
      <FacilityEnergyWaterSection
        energy={{ source: "grid", utility: "PacifiCorp", onSiteGenerationMw: 5, notes: "Note A" }}
        water={{ coolingType: "air", reportedMgd: 1.5, notes: "Note B" }}
        onChangeEnergy={vi.fn()}
        onChangeWater={vi.fn()}
      />
    );

    expect(screen.getByDisplayValue("PacifiCorp")).toBeInTheDocument();
    expect(screen.getByDisplayValue("5")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Note A")).toBeInTheDocument();
    expect(screen.getByDisplayValue("1.5")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Note B")).toBeInTheDocument();
  });

  it("renders both fieldsets even when energy/water are empty objects", () => {
    render(
      <FacilityEnergyWaterSection
        energy={{}}
        water={{}}
        onChangeEnergy={vi.fn()}
        onChangeWater={vi.fn()}
      />
    );

    expect(screen.getByText("Energy")).toBeInTheDocument();
    expect(screen.getByText("Water")).toBeInTheDocument();
  });

  it("calls onChangeEnergy with the FULL energy object on a text field edit (never a partial patch)", async () => {
    const user = userEvent.setup();
    const onChangeEnergy = vi.fn();
    render(
      <FacilityEnergyWaterSection
        energy={{ source: "nuclear", utility: "Existing utility" }}
        water={{}}
        onChangeEnergy={onChangeEnergy}
        onChangeWater={vi.fn()}
      />
    );

    await user.type(screen.getByLabelText(/^utility/i), "!");

    // Last call must carry every prior key (source) plus the edited one —
    // this is the shallow-merge contract: energy is always submitted whole.
    const lastCall = onChangeEnergy.mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ source: "nuclear", utility: "Existing utility!" });
  });

  it("calls onChangeWater with the FULL water object on a numeric field edit", async () => {
    const user = userEvent.setup();
    const onChangeWater = vi.fn();
    render(
      <FacilityEnergyWaterSection
        energy={{}}
        water={{ coolingType: "hybrid", notes: "Keep this" }}
        onChangeEnergy={vi.fn()}
        onChangeWater={onChangeWater}
      />
    );

    await user.type(screen.getByLabelText(/reported.*mgd/i), "2");

    const lastCall = onChangeWater.mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ coolingType: "hybrid", notes: "Keep this" });
    expect(lastCall.reportedMgd).not.toBeUndefined();
  });

  it("sets onSiteGenerationMw to undefined when the field is cleared", async () => {
    const user = userEvent.setup();
    const onChangeEnergy = vi.fn();
    render(
      <FacilityEnergyWaterSection
        energy={{ onSiteGenerationMw: 10 }}
        water={{}}
        onChangeEnergy={onChangeEnergy}
        onChangeWater={vi.fn()}
      />
    );

    const input = screen.getByLabelText(/on-site generation/i);
    await user.clear(input);

    const lastCall = onChangeEnergy.mock.calls.at(-1)?.[0];
    expect(lastCall.onSiteGenerationMw).toBeUndefined();
  });

  it("selects an energy source via the Select and reports it in onChangeEnergy", async () => {
    const user = userEvent.setup();
    const onChangeEnergy = vi.fn();
    render(
      <FacilityEnergyWaterSection
        energy={{}}
        water={{}}
        onChangeEnergy={onChangeEnergy}
        onChangeWater={vi.fn()}
      />
    );

    await user.click(screen.getByRole("combobox", { name: /^source/i }));
    const solarOption = await screen.findByRole("option", { name: /^solar$/i });
    await user.click(solarOption);

    expect(onChangeEnergy).toHaveBeenCalledWith(expect.objectContaining({ source: "solar" }));
  });
});
