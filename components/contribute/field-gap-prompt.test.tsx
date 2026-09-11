import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FieldGapPrompt, SectionGapPrompt } from "./field-gap-prompt";
import { CORRECTABLE_KEYS } from "@/lib/contribute-fields";

describe("FieldGapPrompt — correctable field", () => {
  it("renders an inline correction trigger, not a link", () => {
    render(
      <FieldGapPrompt
        field="jobs"
        facilityId="facility-1"
        facilityName="Test DC"
        label="permanent jobs"
      />
    );

    expect(
      screen.getByRole("button", { name: /know permanent jobs\?/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("opens SuggestCorrection pre-targeted at the field, without the full intro", async () => {
    const user = userEvent.setup();
    render(
      <FieldGapPrompt
        field="jobs"
        facilityId="facility-1"
        facilityName="Test DC"
        label="permanent jobs"
      />
    );

    await user.click(screen.getByRole("button", { name: /know permanent jobs\?/i }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /what.s wrong/i })).toHaveTextContent(
      "Permanent jobs"
    );
    expect(
      screen.queryByText(/compute atlas is meant to be corrected/i)
    ).not.toBeInTheDocument();
  });
});

describe("FieldGapPrompt — non-correctable field", () => {
  it("renders a /contribute link instead of a correction trigger", () => {
    render(
      <FieldGapPrompt
        field="stakeholders"
        facilityId="facility-1"
        facilityName="Test DC"
        label="the stakeholders"
      />
    );

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/contribute");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("mentions the facility name and label without promising an automatic edit", () => {
    render(
      <FieldGapPrompt
        field="stakeholders"
        facilityId="facility-1"
        facilityName="Test DC"
        label="the stakeholders"
      />
    );

    expect(screen.getByText(/test dc/i)).toBeInTheDocument();
    expect(screen.getByText(/send us a link/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Eligibility contract: correctable-vs-not is CORRECTABLE_KEYS.includes(field)
// computed at render time — never a second, hand-maintained list. Iterating
// the real array (rather than a hardcoded snapshot of it) is what makes this
// a regression test for the deferred fast-follow's auto-light-up
// requirement: it keeps passing with zero edits here when CORRECTABLE_KEYS
// widens.
// ---------------------------------------------------------------------------

describe("FieldGapPrompt — eligibility tracks CORRECTABLE_KEYS", () => {
  it("renders the correction affordance for every key currently in CORRECTABLE_KEYS", () => {
    for (const key of CORRECTABLE_KEYS) {
      const { unmount } = render(
        <FieldGapPrompt field={key} facilityId="facility-1" facilityName="Test DC" label={key} />
      );
      expect(
        screen.getByRole("button", { name: new RegExp(`know ${key}`, "i") })
      ).toBeInTheDocument();
      unmount();
    }
  });

  it("renders the lead-form link for a field that is not in CORRECTABLE_KEYS", () => {
    render(
      <FieldGapPrompt
        field="waterCoolingType"
        facilityId="facility-1"
        facilityName="Test DC"
        label="the cooling type"
      />
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "/contribute");
  });
});

// ---------------------------------------------------------------------------
// Keyboard focus visibility — FieldGapPrompt renders ~7 times on a facility
// page, so a keyboard user tabbing through needs a visible focus ring on
// every one. Regression for a LINK_CLASS that dropped the focus-visible
// treatment SECTION_LINK_CLASS already carries.
// ---------------------------------------------------------------------------
describe("FieldGapPrompt — keyboard focus visibility", () => {
  it("renders the correction trigger button with focus-visible ring classes", () => {
    render(
      <FieldGapPrompt
        field="jobs"
        facilityId="facility-1"
        facilityName="Test DC"
        label="permanent jobs"
      />
    );

    const button = screen.getByRole("button", { name: /know permanent jobs\?/i });
    expect(button).toHaveClass(
      "focus-visible:outline-none",
      "focus-visible:ring-2",
      "focus-visible:ring-ring",
      "focus-visible:ring-offset-2"
    );
  });

  it("renders the lead-form link with focus-visible ring classes", () => {
    render(
      <FieldGapPrompt
        field="stakeholders"
        facilityId="facility-1"
        facilityName="Test DC"
        label="the stakeholders"
      />
    );

    const link = screen.getByRole("link");
    expect(link).toHaveClass(
      "focus-visible:outline-none",
      "focus-visible:ring-2",
      "focus-visible:ring-ring",
      "focus-visible:ring-offset-2"
    );
  });
});

// ---------------------------------------------------------------------------
// SectionGapPrompt — whole-group/whole-section gaps. Unlike FieldGapPrompt,
// there is no eligibility check: it always renders the lead-path link, even
// when `label` echoes a key that IS in CORRECTABLE_KEYS, because a whole
// missing section has no single field to target a correction at.
// ---------------------------------------------------------------------------
describe("SectionGapPrompt", () => {
  it("renders a /contribute link mentioning the facility name and label", () => {
    render(<SectionGapPrompt facilityName="Test DC" label="economic impact data" />);

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/contribute");
    expect(link).toHaveTextContent(/economic impact data/i);
    expect(link).toHaveTextContent(/test dc/i);
  });

  it("always renders a link, never a correction dialog trigger, even for a CORRECTABLE_KEYS-shaped label", () => {
    render(<SectionGapPrompt facilityName="Test DC" label="jobs" />);

    expect(screen.getByRole("link")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
