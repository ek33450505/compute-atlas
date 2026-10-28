import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FieldGapPrompt, SectionGapPrompt } from "./field-gap-prompt";
import { CORRECTABLE_KEYS } from "@/lib/contribute-fields";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

    // A gap prompt fills missing data, so it opens framed as an addition, not
    // an error report.
    expect(screen.getByRole("dialog", { name: "Add missing information" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /what are you adding/i })).toHaveTextContent(
      "Permanent jobs"
    );
    expect(screen.queryByRole("combobox", { name: /what.s wrong/i })).not.toBeInTheDocument();
    expect(
      screen.queryByText(/compute atlas is meant to be corrected/i)
    ).not.toBeInTheDocument();
  });
});

describe("FieldGapPrompt — non-correctable field", () => {
  const props = {
    field: "stakeholders",
    facilityId: "facility-1",
    facilityName: "Test DC",
    label: "the stakeholders",
  } as const;

  it("renders a tip trigger button with the same words as before, not a link to /contribute", () => {
    render(<FieldGapPrompt {...props} />);

    expect(
      screen.getByRole("button", {
        name: "Know a source for the stakeholders on Test DC? Send us a link.",
      })
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("opens the dialog on 'Something else', titled for adding, with the label as the topic", async () => {
    const user = userEvent.setup();
    render(<FieldGapPrompt {...props} />);

    await user.click(screen.getByRole("button", { name: /know a source for the stakeholders/i }));

    expect(screen.getByRole("dialog", { name: "Add missing information" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /what are you adding/i })).toHaveTextContent(
      "Something else"
    );
    expect(screen.getByLabelText(/what should we know/i)).toHaveAttribute(
      "placeholder",
      "e.g. the stakeholders, and where you saw it"
    );
    expect(screen.queryByLabelText(/new value/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/compute atlas is meant to be corrected/i)
    ).not.toBeInTheDocument();
  });

  it("puts the facility and topic in the tip it sends, to the leads intake", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchSpy);
    const user = userEvent.setup();
    render(<FieldGapPrompt {...props} />);

    await user.click(screen.getByRole("button", { name: /know a source for the stakeholders/i }));
    await user.type(screen.getByLabelText(/what should we know/i), "named in the filing");
    await user.type(screen.getByLabelText(/source url/i), "https://example.com/filing");
    await user.click(screen.getByRole("button", { name: /send for review/i }));

    await screen.findByText(/we.ll look into it/i);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/leads");
    expect(JSON.parse(init.body as string).note).toBe(
      "Test DC \u2014 the stakeholders: named in the filing"
    );
  });

  // A <button> centres wrapped text; the inline link this replaced was
  // left-aligned, so a long label wrapping under its heading must stay left.
  it("left-aligns the tip trigger, since a long label wraps", () => {
    render(<FieldGapPrompt {...props} />);

    expect(screen.getByRole("button")).toHaveClass("text-left");
  });

  it("mentions the facility name and label without promising an automatic edit", () => {
    render(<FieldGapPrompt {...props} />);

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

  it("renders the tip trigger for a field that is not in CORRECTABLE_KEYS", () => {
    render(
      <FieldGapPrompt
        field="waterCoolingType"
        facilityId="facility-1"
        facilityName="Test DC"
        label="the cooling type"
      />
    );
    expect(
      screen.getByRole("button", { name: /know a source for the cooling type/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Keyboard focus visibility — FieldGapPrompt renders ~7 times on a facility
// page, so a keyboard user tabbing through needs a visible focus ring on
// every one. Regression for a LINK_CLASS that dropped the focus-visible
// treatment SECTION_LINK_CLASS already carries.
// ---------------------------------------------------------------------------
describe("FieldGapPrompt — keyboard focus visibility", () => {
  it("renders the correction trigger button with focus-visible outline classes", () => {
    render(
      <FieldGapPrompt
        field="jobs"
        facilityId="facility-1"
        facilityName="Test DC"
        label="permanent jobs"
      />
    );

    const button = screen.getByRole("button", { name: /know permanent jobs\?/i });
    expect(button).toHaveClass("text-left"); // a wrapped <button> label stays left-aligned
    expect(button).toHaveClass(
      "focus-visible:outline-2",
      "focus-visible:outline-offset-2",
      "focus-visible:outline-ring"
    );
    // outline-none beside outline-2 would force outline-style: none and hide the indicator
    expect(button).not.toHaveClass("focus-visible:outline-none");
  });

  it("renders the tip trigger with focus-visible outline classes", () => {
    render(
      <FieldGapPrompt
        field="stakeholders"
        facilityId="facility-1"
        facilityName="Test DC"
        label="the stakeholders"
      />
    );

    const link = screen.getByRole("button");
    expect(link).toHaveClass(
      "focus-visible:outline-2",
      "focus-visible:outline-offset-2",
      "focus-visible:outline-ring"
    );
    // outline-none beside outline-2 would force outline-style: none and hide the indicator
    expect(link).not.toHaveClass("focus-visible:outline-none");
  });
});

// ---------------------------------------------------------------------------
// SectionGapPrompt — whole-group/whole-section gaps. Unlike FieldGapPrompt,
// there is no eligibility check: it always renders the tip trigger, even when
// `label` echoes a key that IS in CORRECTABLE_KEYS, because a whole missing
// section has no single field to target a correction at.
// ---------------------------------------------------------------------------
describe("SectionGapPrompt", () => {
  const props = { facilityId: "facility-1", facilityName: "Test DC", label: "economic impact data" };

  it("renders a tip trigger button mentioning the facility name and label, not a link", () => {
    render(<SectionGapPrompt {...props} />);

    const trigger = screen.getByRole("button");
    expect(trigger).toHaveTextContent("Know a source for economic impact data on Test DC? Send us a link.");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("is screen-only and carries the quiet section styling", () => {
    render(<SectionGapPrompt {...props} />);

    expect(screen.getByRole("button")).toHaveClass("print:hidden", "text-xs", "italic");
  });

  it("left-aligns the tip trigger, since a long label wraps", () => {
    render(<SectionGapPrompt {...props} />);

    expect(screen.getByRole("button")).toHaveClass("text-left");
  });

  it("opens the dialog on 'Something else' with the label as the topic", async () => {
    const user = userEvent.setup();
    render(<SectionGapPrompt {...props} />);

    await user.click(screen.getByRole("button"));

    expect(screen.getByRole("dialog", { name: "Add missing information" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /what are you adding/i })).toHaveTextContent(
      "Something else"
    );
    expect(screen.getByLabelText(/what should we know/i)).toHaveAttribute(
      "placeholder",
      "e.g. economic impact data, and where you saw it"
    );
  });

  it("opens on 'Something else' even for a CORRECTABLE_KEYS-shaped label, never on that field", async () => {
    const user = userEvent.setup();
    render(<SectionGapPrompt {...props} label="jobs" />);

    await user.click(screen.getByRole("button"));

    expect(screen.getByRole("combobox", { name: /what are you adding/i })).toHaveTextContent(
      "Something else"
    );
    expect(screen.queryByLabelText(/new value/i)).not.toBeInTheDocument();
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

  it("is in the DOM alongside the tip trigger for a non-correctable field", () => {
    render(
      <FieldGapPrompt
        field="stakeholders"
        facilityId="facility-1"
        facilityName="Test DC"
        label="the stakeholders"
      />
    );

    expect(
      screen.getByRole("button", { name: /know a source for the stakeholders/i })
    ).toBeInTheDocument();
    expect(notRecordedNode()).toBeInTheDocument();
  });

  // A section-level gap has no <dt> beside it, so a self-naming marker here
  // printed as an orphan sentence. The consolidated summary line replaced it;
  // this pins that SectionGapPrompt is screen-only and prints nothing.
  it("is absent from a section-level gap, which prints via the consolidated summary", () => {
    render(<SectionGapPrompt facilityId="f" facilityName="Test DC" label="economic impact data" />);

    expect(screen.getByRole("button")).toHaveClass("print:hidden");
    expect(screen.queryByText(/^Not recorded/)).not.toBeInTheDocument();
  });

  it.each([
    ["correctable field", <FieldGapPrompt key="c" field="jobs" facilityId="f" facilityName="Test DC" label="permanent jobs" />],
    ["non-correctable field", <FieldGapPrompt key="n" field="stakeholders" facilityId="f" facilityName="Test DC" label="the stakeholders" />],
  ])(
    "carries `hidden` + the data-print-nil hook and no aria-hidden — %s (DOM contract only)",
    (_case, element) => {
      render(element);

      const marker = screen.getByText("Not recorded");
      // `hidden` is display:none, which is what keeps the marker out of the
      // SCREEN accessibility tree. `aria-hidden` would have worked on screen
      // too but would also have silenced it in print, where it is the only
      // thing standing in for the value — so its absence is the contract.
      expect(marker).toHaveClass("hidden");
      expect(marker).not.toHaveAttribute("aria-hidden");

      // Print visibility is deliberately NOT a utility on this element: it is
      // `[data-print-brief] [data-print-nil]` in app/globals.css, so the
      // marker shows only on the facility brief, where a <dt> labels it. A
      // `print:*` variant here would also show it on /gaps, which is how that
      // page printed 36 unlabelled markers. This pins the hook and the
      // ABSENCE of the variant; that the scoping works is e2e-only.
      expect(marker).toHaveAttribute("data-print-nil");
      expect(marker.className).not.toContain("print:");
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

    expect(screen.getByText("Not recorded")).toHaveAttribute("data-print-nil");
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
// correction dialog trigger, and SectionGapPrompt only ever renders the tip
// trigger (which opens that dialog on "Something else"). The flag suppresses the PRINT marker and must leave the
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
    // not the tip trigger (which opens the dialog on "Something else") that
    // SectionGapPrompt would have downgraded it to.
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
