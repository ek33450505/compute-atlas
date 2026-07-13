import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  FacilityTypeConditionalFields,
  type FacilityOption,
} from "./facility-type-conditional-fields";

const noopHandlers = {
  onChangeAiClassification: vi.fn(),
  onChangeDataCenterEnvironmental: vi.fn(),
  onChangeMining: vi.fn(),
  onChangeCryptoMiningEnvironmental: vi.fn(),
  onChangeGeneration: vi.fn(),
};

function baseProps(overrides: Partial<Parameters<typeof FacilityTypeConditionalFields>[0]> = {}) {
  return {
    facilityType: "data_center" as const,
    aiClassification: "",
    dataCenterEnvironmental: {},
    mining: {},
    cryptoMiningEnvironmental: {},
    generation: {},
    availableFacilities: [] as FacilityOption[],
    ...noopHandlers,
    ...overrides,
  };
}

describe("FacilityTypeConditionalFields — data_center branch", () => {
  it("renders aiClassification and the data-center environmental fieldset", () => {
    render(<FacilityTypeConditionalFields {...baseProps()} />);

    expect(screen.getByText("Data center classification")).toBeInTheDocument();
    expect(screen.getByText("Environmental (data center)")).toBeInTheDocument();
    expect(screen.getByLabelText(/^PUE \(optional\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^WUE \(optional\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/grid carbon intensity/i)).toBeInTheDocument();
    // The renewablePercent Slider's <label> targets a Base UI `<div>` root,
    // which is not a "labellable" element per the HTML spec — getByLabelText
    // correctly refuses that association. Assert via the visible label text
    // instead (matches the pattern used for the slider interaction test
    // below, which also can't rely on label association).
    expect(screen.getByText(/renewable percent \(optional\)/i)).toBeInTheDocument();
  });

  it("does NOT render crypto_mining or power_generation fields", () => {
    render(<FacilityTypeConditionalFields {...baseProps()} />);

    expect(screen.queryByText("Mining")).not.toBeInTheDocument();
    expect(screen.queryByText("Generation")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/carbon intensity proxy/i)).not.toBeInTheDocument();
  });

  it("calls onChangeDataCenterEnvironmental with the FULL object on a numeric edit (shallow-merge rule)", async () => {
    const user = userEvent.setup();
    const onChangeDataCenterEnvironmental = vi.fn();
    render(
      <FacilityTypeConditionalFields
        {...baseProps({
          dataCenterEnvironmental: { pueConfidence: "confirmed" },
          onChangeDataCenterEnvironmental,
        })}
      />
    );

    // Single-character type — see the header comment on the analogous
    // "parses permanent as a nonnegative integer" test in
    // facility-jobs-community-section.test.tsx for why this component's
    // prop-mocked (not internally re-rendered) numeric fields can't be
    // multi-character-typed against a static prop in a single assertion.
    await user.type(screen.getByLabelText(/^PUE \(optional\)/i), "2");

    const lastCall = onChangeDataCenterEnvironmental.mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ pueConfidence: "confirmed" });
    expect(lastCall.pue).not.toBeUndefined();
  });

  it("defaults waterStress to unknown when absent, matching the schema default", () => {
    render(<FacilityTypeConditionalFields {...baseProps()} />);

    // The waterStress Select's trigger renders its current value as its
    // accessible name via SelectValue — assert through the combobox, not a
    // raw text match (which is fragile against the exact DOM structure Base
    // UI's SelectValue uses to render its child span).
    expect(screen.getByRole("combobox", { name: /water stress/i })).toHaveTextContent(/unknown/i);
  });

  it("moves the renewablePercent slider and reports the new value", async () => {
    const onChangeDataCenterEnvironmental = vi.fn();
    const { container } = render(
      <FacilityTypeConditionalFields
        {...baseProps({
          dataCenterEnvironmental: { renewablePercent: 20 },
          onChangeDataCenterEnvironmental,
        })}
      />
    );

    // Base UI's Slider renders a visually-hidden native
    // `<input type="range">` for keyboard/native accessibility — jsdom's
    // layout engine doesn't compute this element as exposing an ARIA
    // "slider" role the way a real browser does (Base UI's Thumb wrapper
    // relies on real layout to become visible), so query the native range
    // input directly rather than via getByRole. It's still the element that
    // actually receives keyboard events.
    const rangeInput = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(rangeInput).toBeTruthy();
    rangeInput.focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(onChangeDataCenterEnvironmental).toHaveBeenCalled();
    const lastCall = onChangeDataCenterEnvironmental.mock.calls.at(-1)?.[0];
    expect(lastCall.renewablePercent).toBeGreaterThan(20);
  });
});

describe("FacilityTypeConditionalFields — crypto_mining branch", () => {
  it("renders aiClassification, mining fields, and the crypto-mining environmental fieldset", () => {
    render(<FacilityTypeConditionalFields {...baseProps({ facilityType: "crypto_mining" })} />);

    expect(screen.getByText("Crypto mining classification")).toBeInTheDocument();
    expect(screen.getByText("Mining")).toBeInTheDocument();
    expect(screen.getByText("Environmental (crypto mining)")).toBeInTheDocument();
    expect(screen.getByLabelText(/hash rate/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/carbon intensity proxy/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/carbon intensity basis/i)).toBeInTheDocument();
  });

  it("does NOT render data_center-only environmental fields (pue/wue/renewablePercent/waterStress)", () => {
    render(<FacilityTypeConditionalFields {...baseProps({ facilityType: "crypto_mining" })} />);

    expect(screen.queryByLabelText(/^PUE \(optional\)/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^WUE \(optional\)/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/renewable percent/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /water stress/i })).not.toBeInTheDocument();
  });

  it("keeps mining{} and environmental{} as two distinct state slices — editing mining never touches cryptoMiningEnvironmental", async () => {
    const user = userEvent.setup();
    const onChangeMining = vi.fn();
    const onChangeCryptoMiningEnvironmental = vi.fn();
    render(
      <FacilityTypeConditionalFields
        {...baseProps({
          facilityType: "crypto_mining",
          mining: { hardwareType: "asic" },
          cryptoMiningEnvironmental: { carbonIntensityBasis: "estimated" },
          onChangeMining,
          onChangeCryptoMiningEnvironmental,
        })}
      />
    );

    // Single-character type — same prop-mocked-field rationale as the PUE
    // test above.
    await user.type(screen.getByLabelText(/hash rate/i), "5");

    expect(onChangeMining).toHaveBeenCalled();
    expect(onChangeCryptoMiningEnvironmental).not.toHaveBeenCalled();
    const lastMiningCall = onChangeMining.mock.calls.at(-1)?.[0];
    expect(lastMiningCall).toMatchObject({ hardwareType: "asic" });
  });

  it("calls onChangeCryptoMiningEnvironmental with the FULL object on a select change", async () => {
    const user = userEvent.setup();
    const onChangeCryptoMiningEnvironmental = vi.fn();
    render(
      <FacilityTypeConditionalFields
        {...baseProps({
          facilityType: "crypto_mining",
          cryptoMiningEnvironmental: { carbonIntensityProxy: 42 },
          onChangeCryptoMiningEnvironmental,
        })}
      />
    );

    await user.click(screen.getByRole("combobox", { name: /carbon intensity basis/i }));
    const option = await screen.findByRole("option", { name: /self-reported/i });
    await user.click(option);

    expect(onChangeCryptoMiningEnvironmental).toHaveBeenCalledWith({
      carbonIntensityProxy: 42,
      carbonIntensityBasis: "self_reported",
    });
  });
});

describe("FacilityTypeConditionalFields — power_generation branch", () => {
  const facilities: FacilityOption[] = [
    { id: "facility-a", name: "Facility A" },
    { id: "facility-b", name: "Facility B" },
    { id: "current-facility", name: "Current Facility" },
  ];

  it("renders the generation fieldset with technology/offtaker/unitCount/notes and no aiClassification/mining/environmental", () => {
    render(
      <FacilityTypeConditionalFields
        {...baseProps({ facilityType: "power_generation", availableFacilities: facilities })}
      />
    );

    expect(screen.getByText("Generation")).toBeInTheDocument();
    expect(screen.getByLabelText(/^offtaker/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/unit count/i)).toBeInTheDocument();
    expect(screen.queryByText("Data center classification")).not.toBeInTheDocument();
    expect(screen.queryByText("Mining")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Environmental/)).not.toBeInTheDocument();
  });

  it("excludes the currently-edited facility from the poweredFacilityIds combobox options", async () => {
    const user = userEvent.setup();
    render(
      <FacilityTypeConditionalFields
        {...baseProps({
          facilityType: "power_generation",
          availableFacilities: facilities,
          currentFacilityId: "current-facility",
        })}
      />
    );

    await user.click(screen.getByRole("button", { name: /powered facilities/i }));

    expect(screen.getByRole("option", { name: "Facility A" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Current Facility" })).not.toBeInTheDocument();
  });

  it("adds a facility to poweredFacilityIds when selected from the combobox", async () => {
    const user = userEvent.setup();
    const onChangeGeneration = vi.fn();
    render(
      <FacilityTypeConditionalFields
        {...baseProps({
          facilityType: "power_generation",
          availableFacilities: facilities,
          generation: { technology: "solar" },
          onChangeGeneration,
        })}
      />
    );

    await user.click(screen.getByRole("button", { name: /powered facilities/i }));
    await user.click(screen.getByRole("option", { name: "Facility A" }));

    expect(onChangeGeneration).toHaveBeenCalledWith({
      technology: "solar",
      poweredFacilityIds: ["facility-a"],
    });
  });

  it("renders selected facilities as removable chips and removes one on click", async () => {
    const user = userEvent.setup();
    const onChangeGeneration = vi.fn();
    render(
      <FacilityTypeConditionalFields
        {...baseProps({
          facilityType: "power_generation",
          availableFacilities: facilities,
          generation: { poweredFacilityIds: ["facility-a", "facility-b"] },
          onChangeGeneration,
        })}
      />
    );

    expect(screen.getByText("Facility A")).toBeInTheDocument();
    expect(screen.getByText("Facility B")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /remove facility a/i }));

    expect(onChangeGeneration).toHaveBeenCalledWith({
      poweredFacilityIds: ["facility-b"],
    });
  });

  it("filters the combobox options by typed query", async () => {
    const user = userEvent.setup();
    render(
      <FacilityTypeConditionalFields
        {...baseProps({ facilityType: "power_generation", availableFacilities: facilities })}
      />
    );

    await user.click(screen.getByRole("button", { name: /powered facilities/i }));
    await user.type(screen.getByRole("textbox", { name: /search facilities/i }), "Facility B");

    expect(screen.getByRole("option", { name: "Facility B" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Facility A" })).not.toBeInTheDocument();
  });

  it("parses unitCount as a truncated integer", async () => {
    const user = userEvent.setup();
    const onChangeGeneration = vi.fn();
    render(
      <FacilityTypeConditionalFields
        {...baseProps({ facilityType: "power_generation", onChangeGeneration })}
      />
    );

    await user.type(screen.getByLabelText(/unit count/i), "4");

    const lastCall = onChangeGeneration.mock.calls.at(-1)?.[0];
    expect(lastCall.unitCount).toBe(4);
  });
});
