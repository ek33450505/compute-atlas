import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Source } from "@/lib/schema";
import { FacilitySubsidiesSection, type SubsidyEntry } from "./facility-subsidies-section";

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    url: "https://example.com/article",
    label: "Press release",
    retrievedAt: "2026-01-01",
    kind: "press",
    ...overrides,
  };
}

function makeSubsidy(overrides: Partial<SubsidyEntry> = {}): SubsidyEntry {
  return {
    program: "Tax abatement",
    amountUsd: 1000,
    jurisdiction: "State",
    year: "2026",
    ...overrides,
  };
}

describe("FacilitySubsidiesSection", () => {
  it("shows an empty-state message when subsidies is empty", () => {
    render(<FacilitySubsidiesSection subsidies={[]} sources={[]} onChange={vi.fn()} />);

    expect(screen.getByText(/no subsidies recorded/i)).toBeInTheDocument();
  });

  it("renders one fieldset per subsidy with its fields populated", () => {
    const subsidies = [
      makeSubsidy({ program: "First program" }),
      makeSubsidy({ program: "Second program" }),
    ];
    render(<FacilitySubsidiesSection subsidies={subsidies} sources={[]} onChange={vi.fn()} />);

    expect(screen.getByDisplayValue("First program")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Second program")).toBeInTheDocument();
    expect(screen.getAllByRole("group")).toHaveLength(2);
  });

  it("adds a new empty row when Add subsidy is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FacilitySubsidiesSection subsidies={[makeSubsidy()]} sources={[]} onChange={onChange} />
    );

    await user.click(screen.getByRole("button", { name: /add subsidy/i }));

    expect(onChange).toHaveBeenCalledWith([makeSubsidy(), {}]);
  });

  it("calls onChange with the row removed when Remove is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const subsidies = [makeSubsidy({ program: "Keep me" }), makeSubsidy({ program: "Remove me" })];
    render(
      <FacilitySubsidiesSection subsidies={subsidies} sources={[]} onChange={onChange} />
    );

    await user.click(screen.getByRole("button", { name: /remove subsidy 2/i }));

    expect(onChange).toHaveBeenCalledWith([subsidies[0]]);
  });

  it("allows removing the last remaining row (no min-1 floor, unlike sources)", () => {
    render(
      <FacilitySubsidiesSection subsidies={[makeSubsidy()]} sources={[]} onChange={vi.fn()} />
    );

    expect(screen.getByRole("button", { name: /remove subsidy 1/i })).toBeEnabled();
  });

  it("swaps two rows when Move down is used", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const subsidies = [makeSubsidy({ program: "Row A" }), makeSubsidy({ program: "Row B" })];
    render(
      <FacilitySubsidiesSection subsidies={subsidies} sources={[]} onChange={onChange} />
    );

    await user.click(screen.getByRole("button", { name: /move subsidy 1 down/i }));

    expect(onChange).toHaveBeenCalledWith([subsidies[1], subsidies[0]]);
  });

  it("disables Move up on the first row and Move down on the last row", () => {
    const subsidies = [makeSubsidy(), makeSubsidy()];
    render(
      <FacilitySubsidiesSection subsidies={subsidies} sources={[]} onChange={vi.fn()} />
    );

    expect(screen.getByRole("button", { name: /move subsidy 1 up/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /move subsidy 2 down/i })).toBeDisabled();
  });

  it("updates a text field via onChange without touching sibling rows", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const subsidies = [makeSubsidy({ program: "Original" })];
    render(
      <FacilitySubsidiesSection subsidies={subsidies} sources={[]} onChange={onChange} />
    );

    await user.type(screen.getByLabelText(/^program/i), "!");

    expect(onChange).toHaveBeenCalledWith([{ ...subsidies[0], program: "Original!" }]);
  });

  it("parses amountUsd as a number when a digit is typed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const subsidies = [makeSubsidy({ amountUsd: undefined })];
    render(
      <FacilitySubsidiesSection subsidies={subsidies} sources={[]} onChange={onChange} />
    );

    await user.type(screen.getByLabelText(/^amount/i), "5");

    expect(onChange).toHaveBeenCalledWith([{ ...subsidies[0], amountUsd: 5 }]);
  });

  it("treats an emptied amountUsd field as undefined, not NaN or 0", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const subsidies = [makeSubsidy({ amountUsd: 42 })];
    render(
      <FacilitySubsidiesSection subsidies={subsidies} sources={[]} onChange={onChange} />
    );

    await user.clear(screen.getByLabelText(/^amount/i));

    expect(onChange).toHaveBeenCalledWith([{ ...subsidies[0], amountUsd: undefined }]);
  });

  it("rejects negative input at the input level via min=0", () => {
    render(
      <FacilitySubsidiesSection subsidies={[makeSubsidy()]} sources={[]} onChange={vi.fn()} />
    );

    expect(screen.getByLabelText(/^amount/i)).toHaveAttribute("min", "0");
  });

  it("passes the live sources array through to the sourceIndex picker", async () => {
    const user = userEvent.setup();
    const sources = [makeSource({ label: "Only source" })];
    render(
      <FacilitySubsidiesSection
        subsidies={[makeSubsidy()]}
        sources={sources}
        onChange={vi.fn()}
      />
    );

    await user.click(screen.getByRole("combobox", { name: /^source/i }));

    // findByRole (async/polling), not getByRole: Base UI's Select popup
    // visibility is animation-gated and can resolve a tick after the click
    // even under jsdom — see facility-source-index-picker.test.tsx's header
    // comment for the full explanation.
    expect(await screen.findByRole("option", { name: /only source/i })).toBeInTheDocument();
  });

  it("sets sourceIndex via the picker without touching other fields", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const sources = [makeSource({ label: "Pick me" })];
    const subsidies = [makeSubsidy({ program: "Keep this program" })];
    render(
      <FacilitySubsidiesSection subsidies={subsidies} sources={sources} onChange={onChange} />
    );

    await user.click(screen.getByRole("combobox", { name: /^source/i }));
    const pickMeOption = await screen.findByRole("option", { name: /pick me/i });
    await user.click(pickMeOption);

    expect(onChange).toHaveBeenCalledWith([{ ...subsidies[0], sourceIndex: 0 }]);
  });
});
