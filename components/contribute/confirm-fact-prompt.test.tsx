import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ConfirmFactPrompt } from "./confirm-fact-prompt";
import { CORRECTABLE_KEYS } from "@/lib/contribute-fields";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConfirmFactPrompt — correctable field", () => {
  it("renders the still-accurate prompt with Yes/No controls", () => {
    render(
      <ConfirmFactPrompt
        field="capacityOperationalMw"
        facilityId="facility-1"
        facilityName="Test DC"
        label="the capacity"
      />
    );

    expect(screen.getByText(/still accurate\?/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Yes, the capacity is still accurate" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "No, the capacity needs a correction" })
    ).toBeInTheDocument();
  });

  it("names the source vintage's year when provided, without inventing a document type", () => {
    render(
      <ConfirmFactPrompt
        field="capacityOperationalMw"
        facilityId="facility-1"
        facilityName="Test DC"
        label="the capacity"
        vintage="2024-06-15"
      />
    );

    expect(screen.getByText(/last updated in 2024\. still accurate\?/i)).toBeInTheDocument();
  });

  it("falls back to date-agnostic copy when no vintage is available", () => {
    render(
      <ConfirmFactPrompt
        field="capacityOperationalMw"
        facilityId="facility-1"
        facilityName="Test DC"
        label="the capacity"
      />
    );

    expect(screen.getByText(/^still accurate\?$/i)).toBeInTheDocument();
  });

  it("'No' opens SuggestCorrection pre-targeted at the field, without the full intro", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmFactPrompt
        field="capacityOperationalMw"
        facilityId="facility-1"
        facilityName="Test DC"
        label="the capacity"
      />
    );

    await user.click(
      screen.getByRole("button", { name: "No, the capacity needs a correction" })
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /what.s wrong/i })).toHaveTextContent(
      "Operational capacity (MW)"
    );
    expect(
      screen.queryByText(/compute atlas is meant to be corrected/i)
    ).not.toBeInTheDocument();
  });

  it("'Yes' acknowledges locally and makes no network call", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const user = userEvent.setup();

    render(
      <ConfirmFactPrompt
        field="capacityOperationalMw"
        facilityId="facility-1"
        facilityName="Test DC"
        label="the capacity"
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Yes, the capacity is still accurate" })
    );

    expect(screen.getByText(/thanks for confirming/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Yes, the capacity is still accurate" })
    ).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("ConfirmFactPrompt — non-correctable field", () => {
  it("renders nothing rather than a dead-end prompt", () => {
    const { container } = render(
      <ConfirmFactPrompt
        field="stakeholders"
        facilityId="facility-1"
        facilityName="Test DC"
        label="the stakeholders"
      />
    );

    expect(container).toBeEmptyDOMElement();
  });
});

// ---------------------------------------------------------------------------
// Eligibility contract: correctable-vs-not is CORRECTABLE_KEYS.includes(field)
// computed at render time — never a second, hand-maintained list. Mirrors
// the equivalent FieldGapPrompt regression test.
// ---------------------------------------------------------------------------

describe("ConfirmFactPrompt — eligibility tracks CORRECTABLE_KEYS", () => {
  it("renders the prompt for every key currently in CORRECTABLE_KEYS", () => {
    for (const key of CORRECTABLE_KEYS) {
      const { unmount, container } = render(
        <ConfirmFactPrompt field={key} facilityId="facility-1" facilityName="Test DC" label={key} />
      );
      expect(container).not.toBeEmptyDOMElement();
      unmount();
    }
  });

  it("renders nothing for a field that is not in CORRECTABLE_KEYS", () => {
    const { container } = render(
      <ConfirmFactPrompt
        field="waterCoolingType"
        facilityId="facility-1"
        facilityName="Test DC"
        label="the cooling type"
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ConfirmFactPrompt — keyboard focus visibility", () => {
  it("renders both controls with focus-visible ring classes", () => {
    render(
      <ConfirmFactPrompt
        field="capacityOperationalMw"
        facilityId="facility-1"
        facilityName="Test DC"
        label="the capacity"
      />
    );

    for (const name of [
      "Yes, the capacity is still accurate",
      "No, the capacity needs a correction",
    ]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveClass(
        "focus-visible:outline-none",
        "focus-visible:ring-2",
        "focus-visible:ring-ring",
        "focus-visible:ring-offset-2"
      );
    }
  });
});
