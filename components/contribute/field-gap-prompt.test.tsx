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

// ---------------------------------------------------------------------------
// Print-only "Not recorded" marker — FIELD level only.
//
// SCOPE WARNING, read before adding to this block: jsdom loads no stylesheet
// and evaluates no `@media print`, so NOTHING here can show the marker is
// visible on paper or hidden on screen — every assertion below is about DOM
// presence and the class/attribute contract only. The assertion that the
// marker actually prints (and actually does not appear on screen) is
// media-emulated in e2e/print-brief.spec.ts and lives there on purpose.
// Test names say "in the DOM" rather than "in print" for that reason.
//
// SectionGapPrompt deliberately carries NO marker: a section-level gap has no
// <dt> to be read against, and one self-naming line per empty section printed
// as a run of orphan sentences. Those are consolidated into a single line at
// the foot of the brief instead — lib/facility-gaps.ts +
// components/facility/print-gap-summary.tsx, covered by their own tests.
// ---------------------------------------------------------------------------

/** The marker as rendered, or null. Not a visibility check — see above. */
function notRecordedNode(): HTMLElement | null {
  return screen.queryByText("Not recorded");
}

describe("print-only 'Not recorded' marker", () => {
  it("is in the DOM alongside the correction trigger for a correctable field", () => {
    render(
      <FieldGapPrompt
        field="jobs"
        facilityId="facility-1"
        facilityName="Test DC"
        label="permanent jobs"
      />
    );

    expect(screen.getByRole("button", { name: /know permanent jobs\?/i })).toBeInTheDocument();
    expect(notRecordedNode()).toBeInTheDocument();
  });

  it("is in the DOM alongside the lead-form link for a non-correctable field", () => {
    render(
      <FieldGapPrompt
        field="stakeholders"
        facilityId="facility-1"
        facilityName="Test DC"
        label="the stakeholders"
      />
    );

    expect(screen.getByRole("link")).toHaveAttribute("href", "/contribute");
    expect(notRecordedNode()).toBeInTheDocument();
  });

  // A section-level gap has no <dt> beside it, so a self-naming marker here
  // printed as an orphan sentence. The consolidated summary line replaced it;
  // this pins that SectionGapPrompt is screen-only and prints nothing.
  it("is absent from a section-level gap, which prints via the consolidated summary", () => {
    render(<SectionGapPrompt facilityName="Test DC" label="economic impact data" />);

    expect(screen.getByRole("link")).toHaveAttribute("href", "/contribute");
    expect(screen.queryByText(/^Not recorded/)).not.toBeInTheDocument();
  });

  it.each([
    ["correctable field", <FieldGapPrompt key="c" field="jobs" facilityId="f" facilityName="Test DC" label="permanent jobs" />],
    ["non-correctable field", <FieldGapPrompt key="n" field="stakeholders" facilityId="f" facilityName="Test DC" label="the stakeholders" />],
  ])(
    "carries `hidden` + print:inline and no aria-hidden — %s (class contract only)",
    (_case, element) => {
      render(element);

      const marker = screen.getByText("Not recorded");
      // `hidden` is display:none, which is what keeps the marker out of the
      // SCREEN accessibility tree. `aria-hidden` would have worked on screen
      // too but would also have silenced it in print, where it is the only
      // thing standing in for the value — so its absence is the contract.
      expect(marker).toHaveClass("hidden", "print:inline");
      expect(marker).not.toHaveAttribute("aria-hidden");
    }
  );

  // The field marker is the bare words in every slot: the <dt> printed beside
  // it already says what is missing, so naming the subject would duplicate it.
  it("never names its own subject at field level", () => {
    render(
      <FieldGapPrompt
        field="subsidies"
        facilityId="facility-1"
        facilityName="Test DC"
        label="a public subsidy"
      />
    );

    expect(screen.getByText("Not recorded")).toHaveClass("print:inline");
    expect(screen.queryByText(/Not recorded: /)).not.toBeInTheDocument();
  });

  it("does not disturb the screen affordance: the trigger keeps its own print:hidden", () => {
    render(
      <FieldGapPrompt
        field="jobs"
        facilityId="facility-1"
        facilityName="Test DC"
        label="permanent jobs"
      />
    );

    // The marker is additive: the prompt it stands in for must still hide
    // itself in print, or paper would carry both the invite and the nil.
    expect(screen.getByRole("button", { name: /know permanent jobs\?/i })).toHaveClass(
      "print:hidden"
    );
    expect(notRecordedNode()).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// `coveredByPrintSummary` — a FieldGapPrompt standing in for a WHOLE group.
//
// SubsidiesGroup (components/facility/civic-impact.tsx) replaces the group's
// heading and list with this prompt, so there is no <dt> beside it and the
// marker printed as a bare "Not recorded" naming nothing — under Civic impact,
// on every record in the dataset, while the consolidated summary was ALREADY
// reporting "public subsidies". Orphaned and duplicated at once.
//
// The screen half is the reason it is not simply switched to SectionGapPrompt:
// `subsidies` IS in CORRECTABLE_KEYS, so this call site renders a real
// correction dialog trigger, and SectionGapPrompt only ever renders the
// lead-form link. The flag suppresses the PRINT marker and must leave the
// screen affordance exactly as it was — that pair is what these tests pin.
//
// Per the scope warning above, this is DOM presence only. That the printed
// page carries no unlabelled marker is asserted in e2e/print-brief.spec.ts,
// where media can actually be emulated.
// ---------------------------------------------------------------------------
describe("FieldGapPrompt — coveredByPrintSummary", () => {
  it("omits the marker from the DOM for a correctable field", () => {
    render(
      <FieldGapPrompt
        field="subsidies"
        facilityId="facility-1"
        facilityName="Test DC"
        label="a public subsidy"
        coveredByPrintSummary
      />
    );

    expect(notRecordedNode()).not.toBeInTheDocument();
  });

  it("omits the marker from the DOM for a non-correctable field too", () => {
    // Both return branches share one `printNil`, so a flag honoured on only
    // the correctable path would still print an orphan from the other.
    render(
      <FieldGapPrompt
        field="stakeholders"
        facilityId="facility-1"
        facilityName="Test DC"
        label="the stakeholders"
        coveredByPrintSummary
      />
    );

    expect(notRecordedNode()).not.toBeInTheDocument();
  });

  it("leaves the screen correction trigger untouched", () => {
    render(
      <FieldGapPrompt
        field="subsidies"
        facilityId="facility-1"
        facilityName="Test DC"
        label="a public subsidy"
        coveredByPrintSummary
      />
    );

    // The whole point of keeping FieldGapPrompt here: a real dialog trigger,
    // not the lead-form link SectionGapPrompt would have downgraded it to.
    expect(
      screen.getByRole("button", { name: /know a public subsidy\?/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("defaults to off, so field-level slots keep their marker", () => {
    // Without an explicit default assertion, deleting `= false` and letting
    // the prop go undefined would read as harmless.
    render(
      <FieldGapPrompt
        field="subsidies"
        facilityId="facility-1"
        facilityName="Test DC"
        label="a public subsidy"
      />
    );

    expect(notRecordedNode()).toBeInTheDocument();
  });
});
