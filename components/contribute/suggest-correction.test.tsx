import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Flag } from "lucide-react";

import { CorrectionNotifyProvider } from "@/components/contribute/correction-notify-context";
import { applyPrefill } from "@/components/contact/contact-form";
import { CORRECTABLE_FIELD_META, type CorrectableKey } from "@/lib/contribute-fields";

import {
  SuggestCorrection,
  buildCorrectionPayload,
  buildLeadTipPayload,
  currentValueFor,
  validateCorrection,
  type CorrectionFormState,
} from "./suggest-correction";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// buildCorrectionPayload — pure helper, exercised directly rather than via
// the Base UI Dialog/Select stack (which is portaled/async in jsdom).
// ---------------------------------------------------------------------------

describe("buildCorrectionPayload", () => {
  const base: CorrectionFormState = {
    field: "operator",
    value: "New Operator LLC",
    sourceUrl: "https://example.com/press-release",
    attribution: "",
    note: "",
    notifyEmail: "",
    website: "",
  };

  it("builds a correction payload for a text field", () => {
    const payload = buildCorrectionPayload("facility-123", base);
    expect(payload).toEqual({
      kind: "correction",
      website: "",
      targetFacilityId: "facility-123",
      field: "operator",
      value: "New Operator LLC",
      sourceUrl: "https://example.com/press-release",
    });
  });

  it("sends number-kind field values as real JSON numbers", () => {
    const payload = buildCorrectionPayload("facility-123", {
      ...base,
      field: "capacityOperationalMw",
      value: "42.5",
    });
    expect(payload.value).toBe(42.5);
    expect(typeof payload.value).toBe("number");
  });

  it("trims the source URL and omits a blank note", () => {
    const payload = buildCorrectionPayload("facility-123", {
      ...base,
      sourceUrl: "  https://example.com/source  ",
    });
    expect(payload.sourceUrl).toBe("https://example.com/source");
    expect(payload).not.toHaveProperty("note");
  });

  it("includes a trimmed note when provided", () => {
    const payload = buildCorrectionPayload("facility-123", {
      ...base,
      note: "  saw this in the local paper  ",
    });
    expect(payload.note).toBe("saw this in the local paper");
  });

  it("includes a trimmed attribution when provided", () => {
    const payload = buildCorrectionPayload("facility-123", {
      ...base,
      attribution: "  jdoe  ",
    });
    expect(payload.attribution).toBe("jdoe");
  });

  it("carries the honeypot value through untouched", () => {
    const payload = buildCorrectionPayload("facility-123", {
      ...base,
      website: "bot-filled-this",
    });
    expect(payload.website).toBe("bot-filled-this");
  });
});

// ---------------------------------------------------------------------------
// Rendered structure / interaction
// ---------------------------------------------------------------------------

describe("SuggestCorrection — structure", () => {
  it("renders the intro copy and a trigger button", () => {
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" />);

    expect(
      screen.getByText(/compute atlas is meant to be corrected/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /suggest a correction/i })
    ).toBeInTheDocument();
  });

  it("hides the intro copy when showIntro is false", () => {
    render(
      <SuggestCorrection
        facilityId="facility-1"
        facilityName="Test DC"
        showIntro={false}
      />
    );

    expect(
      screen.queryByText(/compute atlas is meant to be corrected/i)
    ).not.toBeInTheDocument();
  });

  it("renders a custom trigger in place of the default button", () => {
    render(
      <SuggestCorrection
        facilityId="facility-1"
        facilityName="Test DC"
        triggerLabel="Know operator?"
      />
    );

    expect(
      screen.getByRole("button", { name: /know operator\?/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^suggest a correction$/i })
    ).not.toBeInTheDocument();
  });

  // NOTE: jsdom never server-renders, so this (and the icon test below) pass
  // whether or not the Base UI `render`-prop SSR bug is present. They pin the
  // CLIENT-side contract only. The actual SSR guard — the one that fails when
  // the label stops reaching the served HTML — is e2e/ssr-accessible-names.spec.ts.
  it("passes the custom trigger's label as real text content, not just an accessible name (jsdom/client-side only — real SSR coverage lives in e2e/ssr-accessible-names.spec.ts)", () => {
    render(
      <SuggestCorrection
        facilityId="facility-1"
        facilityName="Test DC"
        triggerLabel="Know operator?"
        triggerClassName="text-sm"
      />
    );

    const trigger = screen.getByRole("button", { name: /know operator\?/i });
    expect(trigger).toHaveTextContent("Know operator?");
    expect(trigger).toHaveClass("text-sm");
  });

  it("renders a leading decorative icon inside a custom trigger without it leaking into the accessible name (jsdom/client-side; regression for the facility masthead strip's icon amendment)", () => {
    render(
      <SuggestCorrection
        facilityId="facility-1"
        facilityName="Test DC"
        triggerLabel={
          <>
            <Flag className="size-3.5" aria-hidden="true" data-testid="flag-icon" />
            Spot an error?
          </>
        }
      />
    );

    const trigger = screen.getByRole("button", { name: "Spot an error?" });
    expect(trigger.querySelector('[data-testid="flag-icon"]')).toBeInTheDocument();
    expect(trigger.querySelector('[data-testid="flag-icon"]')).toHaveAttribute(
      "aria-hidden",
      "true"
    );
  });

  it("applies a custom accessible-name override independent of the visible label", () => {
    render(
      <SuggestCorrection
        facilityId="facility-1"
        facilityName="Test DC"
        triggerLabel="No"
        triggerAriaLabel="No, the capacity needs a correction"
      />
    );

    const trigger = screen.getByRole("button", {
      name: "No, the capacity needs a correction",
    });
    expect(trigger).toHaveTextContent("No");
  });

  it("opens the dialog with the facility name and form fields on trigger click", async () => {
    const user = userEvent.setup();
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" />);

    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Test DC")).toBeInTheDocument();
    expect(screen.getByLabelText(/what.s wrong/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/source url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/name or handle/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /submit correction/i })
    ).toBeInTheDocument();
  });

  it("keeps the honeypot out of the tab order", async () => {
    const user = userEvent.setup();
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" />);

    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));

    // The dialog content is portaled to document.body (Base UI Dialog), not
    // nested under the initial render() container — query the full document.
    const honeypot = document.querySelector('input[name="website"]');
    const honeypotWrapper = honeypot?.closest("div");
    expect(honeypotWrapper).toHaveAttribute("aria-hidden", "true");
    expect(honeypot).toHaveAttribute("tabindex", "-1");
  });
});

// ---------------------------------------------------------------------------
// defaultField — pre-selects the "What's wrong?" select instead of always
// falling back to CORRECTABLE_FIELD_META[0] (regression coverage for the
// gap-prompt deep-link use case).
// ---------------------------------------------------------------------------

describe("SuggestCorrection — defaultField", () => {
  it("pre-selects the targeted field instead of the first option", async () => {
    const user = userEvent.setup();
    render(
      <SuggestCorrection facilityId="facility-1" facilityName="Test DC" defaultField="jobs" />
    );

    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));

    const trigger = screen.getByRole("combobox", { name: /what.s wrong/i });
    expect(trigger).toHaveTextContent("Permanent jobs");
  });

  it("re-applies defaultField (not index 0) when the dialog reopens after a reset", async () => {
    const user = userEvent.setup();
    render(
      <SuggestCorrection facilityId="facility-1" facilityName="Test DC" defaultField="jobs" />
    );

    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));
    // Change the selection away from the default.
    await user.click(screen.getByRole("combobox", { name: /what.s wrong/i }));
    await user.click(await screen.findByRole("option", { name: "Facility name" }));
    expect(screen.getByRole("combobox", { name: /what.s wrong/i })).toHaveTextContent(
      "Facility name"
    );

    // Close without submitting — resetForm() should re-apply defaultField,
    // not fall back to CORRECTABLE_FIELD_META[0].
    await user.click(screen.getByRole("button", { name: /close/i }));
    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));

    expect(screen.getByRole("combobox", { name: /what.s wrong/i })).toHaveTextContent(
      "Permanent jobs"
    );
  });
});

// ---------------------------------------------------------------------------
// Multi-instance DOM id uniqueness — regression test for the id-collision
// fix: two instances on one page previously shared hardcoded ids
// (correction-field, correction-value, etc.), breaking every
// htmlFor/aria-describedby association past the first instance.
// ---------------------------------------------------------------------------

describe("SuggestCorrection — multi-instance id uniqueness", () => {
  it("produces no duplicate DOM ids when two instances are mounted and open", async () => {
    const user = userEvent.setup();
    render(
      <>
        <SuggestCorrection facilityId="facility-1" facilityName="Test DC" defaultField="jobs" />
        <SuggestCorrection
          facilityId="facility-1"
          facilityName="Test DC"
          defaultField="operator"
        />
      </>
    );

    const triggers = screen.getAllByRole("button", { name: /suggest a correction/i });
    expect(triggers).toHaveLength(2);
    await user.click(triggers[0]);
    await user.click(triggers[1]);

    const allIds = Array.from(document.querySelectorAll("[id]")).map((el) => el.id);
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(allIds.length);
  });
});

// ---------------------------------------------------------------------------
// Submit outcomes
// ---------------------------------------------------------------------------

function mockFetchOnce(response: { ok: boolean; status: number; json: () => Promise<unknown> }) {
  global.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

describe("SuggestCorrection — submit outcomes", () => {
  async function openAndFillSourceUrl(user: ReturnType<typeof userEvent.setup>) {
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" />);
    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));
    await user.type(screen.getByLabelText(/new value/i), "Acme Operator");
    await user.type(screen.getByLabelText(/source url/i), "https://example.com/source");
  }

  it("shows a success message on 201", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openAndFillSourceUrl(user);

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    expect(
      await screen.findByText(/your correction is in the review queue/i)
    ).toBeInTheDocument();
  });

  it("sets a review-window expectation and links to the public activity feed on success", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openAndFillSourceUrl(user);

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    await screen.findByText(/your correction is in the review queue/i);
    expect(screen.getByText(/reviewed within about a week/i)).toBeInTheDocument();
    const activityLink = screen.getByRole("link", { name: /public activity feed/i });
    expect(activityLink).toHaveAttribute("href", "/activity");
  });

  it("surfaces a per-field error plus a top-level summary on 400 with multiple issues", async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Please fix the errors below.",
        issues: [
          { path: ["value"], message: "too short" },
          { path: ["sourceUrl"], message: "must be a valid URL" },
        ],
      }),
    });
    const user = userEvent.setup();
    await openAndFillSourceUrl(user);

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    const valueError = await screen.findByText("too short");
    expect(valueError).toHaveAttribute("role", "alert");
    const sourceError = await screen.findByText("must be a valid URL");
    expect(sourceError).toHaveAttribute("role", "alert");

    expect(screen.getByLabelText(/new value/i)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/source url/i)).toHaveAttribute("aria-invalid", "true");

    // Top-level summary stays alongside the field-level errors.
    expect(screen.getByText("Please fix the errors below.")).toBeInTheDocument();
  });

  it("surfaces a generic message on network failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const user = userEvent.setup();
    await openAndFillSourceUrl(user);

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/something went wrong/i);
  });

  it("includes a typed attribution in the submitted correction payload", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openAndFillSourceUrl(user);
    await user.click(screen.getByText("Add a note or credit (optional)"));
    await user.type(screen.getByLabelText(/name or handle/i), "jdoe");

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    await screen.findByText(/your correction is in the review queue/i);

    const mockFetch = global.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.attribution).toBe("jdoe");
  });
});

// ---------------------------------------------------------------------------
// Enum value options — regression for the dialog rendering the STATUS values
// as the "New value" options of every enum-kind field. The server validates
// against each field's own enumValues, so water/energy/community submissions
// could never succeed.
// ---------------------------------------------------------------------------

describe("SuggestCorrection — enum value options", () => {
  const ENUM_KEYS: CorrectableKey[] = ["status", "water", "energy", "community"];

  async function openValueSelect(user: ReturnType<typeof userEvent.setup>, field: CorrectableKey) {
    render(
      <SuggestCorrection facilityId="facility-1" facilityName="Test DC" defaultField={field} />
    );
    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));
    await user.click(screen.getByRole("combobox", { name: /new value/i }));
  }

  it.each(ENUM_KEYS)("offers exactly the %s field's own labels, in enumValues order", async (key) => {
    const meta = CORRECTABLE_FIELD_META.find((m) => m.key === key)!;
    const expected = (meta.enumValues ?? []).map((v) => meta.enumLabels![v]);
    const user = userEvent.setup();

    await openValueSelect(user, key);

    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(expected);
  });

  it("does not offer a status value (Operational) for the cooling-type field", async () => {
    const user = userEvent.setup();

    await openValueSelect(user, "water");

    await screen.findByRole("option", { name: "Air-cooled" });
    expect(screen.queryByRole("option", { name: "Operational" })).not.toBeInTheDocument();
  });

  it("submits the picked cooling type's enum value, not a label or a status", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();

    await openValueSelect(user, "water");
    await user.click(await screen.findByRole("option", { name: "Air-cooled" }));
    await user.type(screen.getByLabelText(/source url/i), "https://example.com/source");
    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    await screen.findByText(/your correction is in the review queue/i);

    const mockFetch = global.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.field).toBe("water");
    expect(body.value).toBe("air");
  });

  // Literal on purpose: the it.each above reads its expectation back from
  // meta.enumLabels, so a wrong label string there would pass it.
  it("pins the cooling-type label strings", async () => {
    const user = userEvent.setup();

    await openValueSelect(user, "water");

    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Evaporative",
      "Air-cooled",
      "Closed-loop",
      "Hybrid",
      "Unknown",
    ]);
  });

  it("pins the community-response label strings", async () => {
    const user = userEvent.setup();

    await openValueSelect(user, "community");

    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Supported",
      "Mixed",
      "Contested",
      "Opposed",
      "Litigation",
      "Unknown",
    ]);
  });

  // The production path: the dialog opens on the default field and the user
  // switches to an enum-kind field, rather than a gap prompt deep-linking one.
  it("swaps the value options when the user switches between enum fields", async () => {
    const user = userEvent.setup();
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" />);
    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));

    await user.click(screen.getByRole("combobox", { name: /what.s wrong/i }));
    await user.click(await screen.findByRole("option", { name: "Cooling type" }));
    await user.click(screen.getByRole("combobox", { name: /new value/i }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([
      "Evaporative",
      "Air-cooled",
      "Closed-loop",
      "Hybrid",
      "Unknown",
    ]);

    // Pick a value, then switch fields: the "What's wrong?" handler must clear
    // it, or the stale "air" would be submitted as an energy source and 400.
    await user.click(screen.getByRole("option", { name: "Air-cooled" }));
    expect(screen.getByRole("combobox", { name: /new value/i })).toHaveTextContent("Air-cooled");

    await user.click(screen.getByRole("combobox", { name: /what.s wrong/i }));
    await user.click(await screen.findByRole("option", { name: "Energy source" }));
    expect(screen.getByRole("combobox", { name: /new value/i })).toHaveTextContent("Select a value");

    await user.click(screen.getByRole("combobox", { name: /new value/i }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([
      "Grid",
      "On-site gas",
      "Nuclear",
      "Solar",
      "Wind",
      "Hydro",
      "Mixed",
      "Other",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Intent framing — "Know the capacity?" fills a gap, it doesn't report an
// error, so FieldGapPrompt opens the dialog with intent="add".
// ---------------------------------------------------------------------------

describe("SuggestCorrection — intent framing", () => {
  it('defaults to the correction framing: "Suggest a correction" / "What\u2019s wrong?"', async () => {
    const user = userEvent.setup();
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" />);

    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));

    expect(screen.getByRole("dialog", { name: "Suggest a correction" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /what.s wrong/i })).toBeInTheDocument();
  });

  it('intent="add" retitles the dialog and relabels the field select', async () => {
    const user = userEvent.setup();
    render(
      <SuggestCorrection
        facilityId="facility-1"
        facilityName="Test DC"
        intent="add"
        triggerLabel="Know the capacity?"
      />
    );

    await user.click(screen.getByRole("button", { name: /know the capacity/i }));

    expect(screen.getByRole("dialog", { name: "Add missing information" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /what are you adding/i })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /what.s wrong/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Short screens, optional-field disclosure and source hint copy
// ---------------------------------------------------------------------------

describe("SuggestCorrection — form layout and copy", () => {
  // jsdom has no layout, so this pins the classes that produce the behaviour:
  // the popup is capped and never scrolls itself (its absolutely positioned
  // close button would scroll away with it); only the body wrapper scrolls.
  it("caps the dialog at the viewport and scrolls only the body, keeping the header and close button fixed", async () => {
    const user = userEvent.setup();
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" />);

    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("max-h-[calc(100dvh-2rem)]", "grid-rows-[auto_minmax(0,1fr)]");
    expect(dialog).not.toHaveClass("overflow-y-auto");

    const scrollBody = screen.getByLabelText(/source url/i).closest(".overflow-y-auto");
    expect(scrollBody).not.toBeNull();
    expect(scrollBody).not.toBe(dialog);
    expect(scrollBody).toHaveClass("min-h-0");
    expect(scrollBody).not.toContainElement(screen.getByText("Test DC"));
    expect(scrollBody).not.toContainElement(screen.getByRole("button", { name: "Close" }));
  });

  it("keeps the name and note fields behind a closed disclosure that opens on click", async () => {
    const user = userEvent.setup();
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" />);
    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));

    const summary = screen.getByText("Add a note or credit (optional)");
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByLabelText(/name or handle/i)).not.toBeVisible();
    expect(screen.getByLabelText(/^note/i)).not.toBeVisible();

    await user.click(summary);

    expect(details).toHaveAttribute("open");
    expect(screen.getByLabelText(/name or handle/i)).toBeVisible();
    expect(screen.getByLabelText(/^note/i)).toBeVisible();
  });

  it("asks where the submitter saw it, instead of the old one-line source hint", async () => {
    const user = userEvent.setup();
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" />);
    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));

    expect(
      screen.getByText("Where did you see it? A news story, permit, filing, or company page.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/backs up this change/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// "Currently: …" — the facility's present value under the field select, so
// the submitter can see what they are correcting.
// ---------------------------------------------------------------------------

describe("SuggestCorrection — current value line", () => {
  async function open(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /suggest a correction|know/i }));
  }

  it("shows the facility's current value for the targeted field", async () => {
    const user = userEvent.setup();
    render(
      <SuggestCorrection
        facilityId="facility-1"
        facilityName="Test DC"
        defaultField="capacityOperationalMw"
        currentValues={{ capacityOperationalMw: "300 MW" }}
      />
    );
    await open(user);

    expect(screen.getByText("Currently: 300 MW")).toBeInTheDocument();
  });

  it("says 'not recorded' when currentValues is given but lacks the targeted field", async () => {
    const user = userEvent.setup();
    render(
      <SuggestCorrection
        facilityId="facility-1"
        facilityName="Test DC"
        defaultField="capacityOperationalMw"
        currentValues={{ name: "Test DC" }}
      />
    );
    await open(user);

    expect(screen.getByText("Currently: not recorded")).toBeInTheDocument();
  });

  it('says "not recorded" for an intent="add" dialog still on its defaultField, even without currentValues', async () => {
    const user = userEvent.setup();
    render(
      <SuggestCorrection
        facilityId="facility-1"
        facilityName="Test DC"
        defaultField="jobs"
        intent="add"
        triggerLabel="Know permanent jobs?"
      />
    );
    await open(user);

    expect(screen.getByText("Currently: not recorded")).toBeInTheDocument();
  });

  it("renders nothing when there are no currentValues and the dialog is not a gap prompt", async () => {
    const user = userEvent.setup();
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" defaultField="jobs" />);
    await open(user);

    expect(screen.queryByText(/currently:/i)).not.toBeInTheDocument();
  });

  it("renders nothing for an add dialog once the user switches off its defaultField (no currentValues)", async () => {
    const user = userEvent.setup();
    render(
      <SuggestCorrection
        facilityId="facility-1"
        facilityName="Test DC"
        defaultField="jobs"
        intent="add"
        triggerLabel="Know permanent jobs?"
      />
    );
    await open(user);
    expect(screen.getByText("Currently: not recorded")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: /what are you adding/i }));
    await user.click(await screen.findByRole("option", { name: "Operator" }));

    expect(screen.queryByText(/currently:/i)).not.toBeInTheDocument();
  });

  it("follows the field when the user switches it", async () => {
    const user = userEvent.setup();
    render(
      <SuggestCorrection
        facilityId="facility-1"
        facilityName="Test DC"
        defaultField="name"
        currentValues={{ name: "Colossus", operator: "xAI" }}
      />
    );
    await open(user);
    expect(screen.getByText("Currently: Colossus")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: /what.s wrong/i }));
    await user.click(await screen.findByRole("option", { name: "Operator" }));

    expect(screen.getByText("Currently: xAI")).toBeInTheDocument();
    expect(screen.queryByText("Currently: Colossus")).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: /what.s wrong/i }));
    await user.click(await screen.findByRole("option", { name: "Powered by" }));

    expect(screen.getByText("Currently: not recorded")).toBeInTheDocument();
  });

  it("describes the field select by the current-value line, for screen readers", async () => {
    const user = userEvent.setup();
    render(
      <SuggestCorrection
        facilityId="facility-1"
        facilityName="Test DC"
        defaultField="capacityOperationalMw"
        currentValues={{ capacityOperationalMw: "300 MW" }}
      />
    );
    await open(user);

    expect(screen.getByRole("combobox", { name: /what.s wrong/i })).toHaveAccessibleDescription(
      "Currently: 300 MW"
    );
  });

  it("leaves the field select undescribed when there is no current-value line", async () => {
    const user = userEvent.setup();
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" />);
    await open(user);

    expect(screen.getByRole("combobox", { name: /what.s wrong/i })).not.toHaveAttribute(
      "aria-describedby"
    );
  });
});

// The pure rule behind the "Currently: …" line (the component tests above
// exercise it through the dialog).
describe("currentValueFor", () => {
  it("returns the facility's value when currentValues has the field", () => {
    expect(
      currentValueFor({
        currentValues: { jobs: "1,200" },
        intent: "correct",
        field: "jobs",
        defaultField: undefined,
      })
    ).toBe("1,200");
  });

  it("says 'not recorded' when currentValues exists but lacks the field, whatever the intent", () => {
    for (const intent of ["correct", "add"] as const) {
      expect(
        currentValueFor({
          currentValues: { name: "Test DC" },
          intent,
          field: "jobs",
          defaultField: "name",
        })
      ).toBe("not recorded");
    }
  });

  it("says 'not recorded' without currentValues only for an add dialog still on its default field", () => {
    expect(
      currentValueFor({ currentValues: undefined, intent: "add", field: "jobs", defaultField: "jobs" })
    ).toBe("not recorded");
  });

  it.each([
    ["a correct dialog on its default field", "correct", "jobs", "jobs"],
    ["an add dialog switched off its default field", "add", "operator", "jobs"],
    ["an add dialog with no default field", "add", "jobs", undefined],
  ] as const)("says nothing without currentValues for %s", (_name, intent, field, defaultField) => {
    expect(currentValueFor({ currentValues: undefined, intent, field, defaultField })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Input handling — people type "1.2 GW" and "example.com/a", and a typo should
// be caught here, in plain words, rather than as a bare server 400.
// ---------------------------------------------------------------------------

describe("validateCorrection", () => {
  const base: CorrectionFormState = {
    field: "name",
    value: "Colossus",
    sourceUrl: "https://example.com/source",
    attribution: "",
    note: "",
    notifyEmail: "",
    website: "",
  };

  it("returns no issues for a complete, valid form", () => {
    expect(validateCorrection(base)).toEqual({});
  });

  it.each([
    ["a blank text value", { field: "name", value: "   " }, "Enter a new value."],
    ["no enum option chosen", { field: "water", value: "" }, "Select a value."],
    ["an enum value from another field", { field: "water", value: "operational" }, "Select a value."],
    ["no state chosen", { field: "state", value: "" }, "Select a state."],
    [
      "an unparseable number",
      { field: "capacityOperationalMw", value: "lots" },
      "Enter a number in megawatts, like 300 or 1.2 GW.",
    ],
  ] as const)("flags %s", (_name, overrides, message) => {
    expect(validateCorrection({ ...base, ...overrides })).toEqual({ value: message });
  });

  it("accepts a typed number with a unit", () => {
    expect(validateCorrection({ ...base, field: "capacityOperationalMw", value: "1.2 GW" })).toEqual({});
  });

  it.each([
    ["no source", "", "Add a link to a public source."],
    ["only whitespace", "   ", "Add a link to a public source."],
    ["a non-http scheme", "ftp://example.com/a", "Paste the full link, starting with https://"],
    ["a javascript: link", "javascript:alert(1)", "Paste the full link, starting with https://"],
    ["text that isn't a link", "not a url", "Paste the full link, starting with https://"],
  ])("flags %s as a source problem", (_name, sourceUrl, message) => {
    expect(validateCorrection({ ...base, sourceUrl })).toEqual({ sourceUrl: message });
  });

  it("accepts a source with the scheme left off (it is added on submit)", () => {
    expect(validateCorrection({ ...base, sourceUrl: "example.com/a" })).toEqual({});
  });

  it("reports the value and the source together", () => {
    expect(validateCorrection({ ...base, value: "", sourceUrl: "" })).toEqual({
      value: "Enter a new value.",
      sourceUrl: "Add a link to a public source.",
    });
  });
});

describe("buildCorrectionPayload — typed numbers and links", () => {
  const base: CorrectionFormState = {
    field: "capacityOperationalMw",
    value: "1.2 GW",
    sourceUrl: "example.com/a",
    attribution: "",
    note: "",
    notifyEmail: "",
    website: "",
  };

  it("sends a parsed number, not the typed text", () => {
    expect(buildCorrectionPayload("f", base).value).toBe(1200);
    expect(buildCorrectionPayload("f", { ...base, field: "subsidies", value: "$12.5M" }).value).toBe(
      12_500_000
    );
  });

  it("sends the link with https:// added", () => {
    expect(buildCorrectionPayload("f", base).sourceUrl).toBe("https://example.com/a");
  });

  // validateCorrection gates the dialog, so this can't happen there. A caller
  // that skips it must get an error, not a guess: Number("1e3") is 1000 and
  // Number("0x10") is 16.
  it.each([["1e3"], ["0x10"], ["lots"], [""]])("throws rather than guess at %j", (value) => {
    expect(() => buildCorrectionPayload("f", { ...base, value })).toThrow(/capacityOperationalMw/);
  });
});

describe("SuggestCorrection — validation before submit", () => {
  function spyOnFetch() {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    return fetchSpy;
  }

  async function openDialog(
    user: ReturnType<typeof userEvent.setup>,
    defaultField?: CorrectableKey
  ) {
    render(
      <SuggestCorrection facilityId="facility-1" facilityName="Test DC" defaultField={defaultField} />
    );
    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));
  }

  const submit = (user: ReturnType<typeof userEvent.setup>) =>
    user.click(screen.getByRole("button", { name: /submit correction/i }));

  it("blocks an empty value, says why, and puts focus on it", async () => {
    const fetchSpy = spyOnFetch();
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(screen.getByLabelText(/source url/i), "https://example.com/source");

    await submit(user);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a new value.")).toHaveAttribute("role", "alert");
    expect(screen.getByText("Please fix the errors below.")).toBeInTheDocument();
    const value = screen.getByLabelText(/new value/i);
    expect(value).toHaveAttribute("aria-invalid", "true");
    expect(value).toHaveAccessibleDescription("Enter a new value.");
    expect(value).toHaveFocus();
  });

  it("blocks a missing source and puts focus on it when the value is fine", async () => {
    const fetchSpy = spyOnFetch();
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(screen.getByLabelText(/new value/i), "Colossus");

    await submit(user);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Add a link to a public source.")).toBeInTheDocument();
    const source = screen.getByLabelText(/source url/i);
    expect(source).toHaveAttribute("aria-invalid", "true");
    expect(source).toHaveFocus();
  });

  it("shows both errors and focuses the value first when both are wrong", async () => {
    const fetchSpy = spyOnFetch();
    const user = userEvent.setup();
    await openDialog(user);

    await submit(user);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Enter a new value.")).toBeInTheDocument();
    expect(screen.getByText("Add a link to a public source.")).toBeInTheDocument();
    expect(screen.getByLabelText(/new value/i)).toHaveFocus();
  });

  it.each([
    ["ftp://x.org/a"],
    ["javascript:alert(1)"],
    // Would become a valid https URL if normalising rewrote it.
    ["javascript://x.org/%0aalert(1)"],
    ["not a url"],
  ])(
    "blocks the source %j with a friendly message and no request",
    async (source) => {
      const fetchSpy = spyOnFetch();
      const user = userEvent.setup();
      await openDialog(user);
      await user.type(screen.getByLabelText(/new value/i), "Colossus");
      await user.type(screen.getByLabelText(/source url/i), source);

      await submit(user);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(screen.getByText("Paste the full link, starting with https://")).toBeInTheDocument();
    }
  );

  it("blocks an enum field with nothing chosen and focuses its select", async () => {
    const fetchSpy = spyOnFetch();
    const user = userEvent.setup();
    await openDialog(user, "water");
    await user.type(screen.getByLabelText(/source url/i), "https://example.com/source");

    await submit(user);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Select a value.")).toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: /new value/i });
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toHaveFocus();
  });

  it("blocks a state field with nothing chosen", async () => {
    const fetchSpy = spyOnFetch();
    const user = userEvent.setup();
    await openDialog(user, "state");
    await user.type(screen.getByLabelText(/source url/i), "https://example.com/source");

    await submit(user);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Select a state.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /new value/i })).toHaveAttribute("aria-invalid", "true");
  });
});

describe("SuggestCorrection — number fields", () => {
  async function openDialog(user: ReturnType<typeof userEvent.setup>, field: CorrectableKey) {
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" defaultField={field} />);
    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));
  }

  function postedBody() {
    const mockFetch = global.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
    return JSON.parse(mockFetch.mock.calls[0][1].body as string);
  }

  it("takes text, not a number spinner, so '1.2 GW' can be typed", async () => {
    const user = userEvent.setup();
    await openDialog(user, "capacityOperationalMw");

    const input = screen.getByLabelText(/new value/i);
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("inputmode", "decimal");
    expect(input).not.toHaveAttribute("min");
    expect(input).not.toHaveAttribute("step");
  });

  it("posts 1200 for '1.2 GW' on a capacity field", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openDialog(user, "capacityOperationalMw");
    await user.type(screen.getByLabelText(/new value/i), "1.2 GW");
    await user.type(screen.getByLabelText(/source url/i), "https://example.com/source");

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    await screen.findByText(/your correction is in the review queue/i);
    expect(postedBody().value).toBe(1200);
    expect(postedBody().field).toBe("capacityOperationalMw");
  });

  it("posts 12500000 for '$12.5M' on subsidies", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openDialog(user, "subsidies");
    await user.type(screen.getByLabelText(/new value/i), "$12.5M");
    await user.type(screen.getByLabelText(/source url/i), "https://example.com/source");

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    await screen.findByText(/your correction is in the review queue/i);
    expect(postedBody().value).toBe(12_500_000);
  });

  it("posts 2500 for '2.5k' on jobs", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openDialog(user, "jobs");
    await user.type(screen.getByLabelText(/new value/i), "2.5k");
    await user.type(screen.getByLabelText(/source url/i), "https://example.com/source");

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    await screen.findByText(/your correction is in the review queue/i);
    expect(postedBody().value).toBe(2500);
  });

  it.each([
    ["capacityOperationalMw", "abc", "Enter a number in megawatts, like 300 or 1.2 GW."],
    ["capacityPlannedMw", "1.2M", "Enter a number in megawatts, like 300 or 1.2 GW."],
    ["subsidies", "1.2 GW", "Enter a dollar amount, like 12,500,000 or 12.5M."],
    ["jobs", "12.5", "Enter a whole number, like 1,200."],
    ["jobs", "0", "Enter a number greater than 0."],
  ] as const)("%s: %j shows that field's message and posts nothing", async (field, typed, message) => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const user = userEvent.setup();
    await openDialog(user, field);
    await user.type(screen.getByLabelText(/new value/i), typed);
    await user.type(screen.getByLabelText(/source url/i), "https://example.com/source");

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText(/new value/i)).toHaveFocus();
  });

  it.each([
    ["capacityOperationalMw", "In megawatts. 1.2 GW works too."],
    ["capacityPlannedMw", "In megawatts. 1.2 GW works too."],
    ["subsidies", "In US dollars. 12.5M or 1.2B works too."],
    ["jobs", "Permanent jobs only."],
  ] as const)("%s describes itself with its hint", async (field, hint) => {
    const user = userEvent.setup();
    await openDialog(user, field);

    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(screen.getByLabelText(/new value/i)).toHaveAccessibleDescription(hint);
  });

  it("describes the input by both the hint and the error once it is invalid", async () => {
    const user = userEvent.setup();
    await openDialog(user, "capacityOperationalMw");
    await user.type(screen.getByLabelText(/new value/i), "abc");
    await user.type(screen.getByLabelText(/source url/i), "https://example.com/source");

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    const description = screen.getByLabelText(/new value/i).getAttribute("aria-describedby") ?? "";
    expect(description.split(" ")).toHaveLength(2);
    expect(screen.getByLabelText(/new value/i)).toHaveAccessibleDescription(
      /In megawatts\. 1\.2 GW works too\..*Enter a number in megawatts/
    );
  });

  // validateFieldValue (lib/contribute.ts) rejects text over 200 with "must be
  // 1-200 characters"; the 2000 in correctionSchema is only the outer cap.
  it("limits a text value to 200 characters, validateFieldValue's 1-200 rule", async () => {
    const user = userEvent.setup();
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" />);
    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));

    expect(screen.getByLabelText(/new value/i)).toHaveAttribute("maxlength", "200");
  });
});

describe("SuggestCorrection — source link", () => {
  function postedBody() {
    const mockFetch = global.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
    return JSON.parse(mockFetch.mock.calls[0][1].body as string);
  }

  async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" />);
    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));
  }

  it("posts a scheme-less link with https:// added", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(screen.getByLabelText(/new value/i), "Colossus");
    await user.type(screen.getByLabelText(/source url/i), "example.com/x");

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    await screen.findByText(/your correction is in the review queue/i);
    expect(postedBody().sourceUrl).toBe("https://example.com/x");
  });

  it("posts a host:port link with https:// added", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(screen.getByLabelText(/new value/i), "Colossus");
    await user.type(screen.getByLabelText(/source url/i), "example.com:8080/a");

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    await screen.findByText(/your correction is in the review queue/i);
    expect(postedBody().sourceUrl).toBe("https://example.com:8080/a");
  });

  it("shows the added https:// when the field loses focus", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    const source = screen.getByLabelText(/source url/i);
    await user.type(source, "example.com/x");
    expect(source).toHaveValue("example.com/x");

    await user.tab();

    expect(source).toHaveValue("https://example.com/x");
  });

  it("leaves a link that already has a scheme untouched on blur", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    const source = screen.getByLabelText(/source url/i);
    await user.type(source, "HTTPS://Example.com/x");

    await user.tab();

    expect(source).toHaveValue("HTTPS://Example.com/x");
  });

  it("replaces the server's bare 'Invalid URL' with the friendly message", async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Please fix the errors below.",
        issues: [{ path: ["sourceUrl"], message: "Invalid URL" }],
      }),
    });
    const user = userEvent.setup();
    await openDialog(user);
    await user.type(screen.getByLabelText(/new value/i), "Colossus");
    await user.type(screen.getByLabelText(/source url/i), "https://example.com/x");

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    expect(
      await screen.findByText("Paste the full link, starting with https://")
    ).toBeInTheDocument();
    expect(screen.queryByText("Invalid URL")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// "Something else" — free text, sent to /api/leads as a source-cited tip.
// ---------------------------------------------------------------------------

describe("buildLeadTipPayload", () => {
  const base: CorrectionFormState = {
    field: "other",
    value: "  the build was cancelled  ",
    sourceUrl: "example.com/a",
    attribution: "",
    note: "ignored: the textarea replaces the note",
    notifyEmail: "",
    website: "",
  };

  it("prefixes the note with the facility, and normalises the link", () => {
    expect(buildLeadTipPayload("Test DC", base)).toEqual({
      url: "https://example.com/a",
      note: "Test DC: the build was cancelled",
      website: "",
    });
  });

  it("adds the topic after an em dash when there is one", () => {
    expect(buildLeadTipPayload("Test DC", base, "the investment amount").note).toBe(
      "Test DC — the investment amount: the build was cancelled"
    );
  });

  it("includes a trimmed attribution, and omits a blank one", () => {
    expect(buildLeadTipPayload("Test DC", { ...base, attribution: "  jdoe " }).attribution).toBe("jdoe");
    expect(buildLeadTipPayload("Test DC", { ...base, attribution: "   " })).not.toHaveProperty(
      "attribution"
    );
  });

  it("carries the honeypot through", () => {
    expect(buildLeadTipPayload("Test DC", { ...base, website: "spam.example" }).website).toBe(
      "spam.example"
    );
  });

  // "Facility \u2014 topic: " is held to 100 units so the person's 400 always fit.
  describe("100-unit prefix", () => {
    const userText = "t".repeat(400);
    const note = (facility: string, topic?: string) =>
      buildLeadTipPayload(facility, { ...base, value: userText }, topic).note as string;

    it("shortens a 300-character facility name with an ellipsis and keeps all 400 of the person's characters", () => {
      const result = note("N".repeat(300));
      expect(result).toBe(`${"N".repeat(97)}\u2026: ${userText}`);
      expect(result.length).toBe(500);
    });

    it("keeps the topic whole and shortens the facility name instead", () => {
      const result = note("N".repeat(300), "the investment amount");
      const prefix = result.slice(0, result.length - userText.length);
      expect(prefix).toContain(" \u2014 the investment amount: ");
      expect(prefix).toContain("\u2026 \u2014 the investment amount");
      expect(prefix.length).toBeLessThanOrEqual(100);
      expect(result.endsWith(userText)).toBe(true);
    });

    it("caps an over-long topic too, so the prefix still fits", () => {
      const result = note("Test DC", "x".repeat(300));
      const prefix = result.slice(0, result.length - userText.length);
      expect(prefix.length).toBeLessThanOrEqual(100);
      expect(prefix).toContain("\u2026");
      expect(result.endsWith(userText)).toBe(true);
      expect(result.length).toBeLessThanOrEqual(500);
    });

    it("leaves a short facility name and topic alone", () => {
      expect(note("Test DC", "the investment amount")).toBe(
        `Test DC \u2014 the investment amount: ${userText}`
      );
    });

    it("never splits an emoji where the facility name is cut", () => {
      const result = note("\u{1F600}".repeat(200));
      expect(result.length).toBeLessThanOrEqual(500);
      expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      expect(result.endsWith(userText)).toBe(true);
    });
  });

  // leadInputSchema caps the note at 500 UTF-16 units. "F: " is 3 of them.
  describe("500-unit cap", () => {
    const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const tip = (value: string) => buildLeadTipPayload("F", { ...base, value }).note as string;

    it("keeps an emoji that ends exactly at 500", () => {
      const note = tip(`${"a".repeat(495)}\u{1F600}b`);
      expect(note).toBe(`F: ${"a".repeat(495)}\u{1F600}`);
      expect(note).toHaveLength(500);
    });

    // 3 + 496 + a 2-unit emoji is 500 code points but 501 UTF-16 units, which
    // the schema rejects: counting code points alone is not enough.
    it("drops an emoji that would cross 500 UTF-16 units, rather than splitting it", () => {
      const note = tip(`${"a".repeat(496)}\u{1F600}`);
      expect(note).toBe(`F: ${"a".repeat(496)}`);
      expect(note.length).toBeLessThanOrEqual(500);
      expect(note).not.toMatch(LONE_SURROGATE);
    });

    it("never exceeds 500 and never leaves half an emoji, whatever the length", () => {
      for (let n = 480; n <= 505; n++) {
        const note = tip("\u{1F600}".repeat(n));
        expect(note.length).toBeLessThanOrEqual(500);
        expect(note).not.toMatch(LONE_SURROGATE);
      }
    });

    it("does not leave a trailing space where the cut lands", () => {
      expect(tip(`${"a".repeat(496)} b`)).toBe(`F: ${"a".repeat(496)}`);
    });

    it("leaves a short note untouched", () => {
      expect(tip("short")).toBe("F: short");
    });
  });

  it("is a lead, so the correction builder refuses 'Something else'", () => {
    expect(() => buildCorrectionPayload("f", base)).toThrow(/Something else/);
  });
});

describe("validateCorrection — Something else", () => {
  const base: CorrectionFormState = {
    field: "other",
    value: "the build was cancelled",
    sourceUrl: "https://example.com/source",
    attribution: "",
    note: "",
    notifyEmail: "",
    website: "",
  };

  it("accepts text and a source", () => {
    expect(validateCorrection(base)).toEqual({});
  });

  it.each([[""], ["   "]])("requires the text (%j)", (value) => {
    expect(validateCorrection({ ...base, value })).toEqual({ value: "Tell us what to look into." });
  });

  it("still requires a source, with the usual rules", () => {
    expect(validateCorrection({ ...base, sourceUrl: "" })).toEqual({
      sourceUrl: "Add a link to a public source.",
    });
    expect(validateCorrection({ ...base, sourceUrl: "ftp://x.org/a" })).toEqual({
      sourceUrl: "Paste the full link, starting with https://",
    });
  });
});

describe("SuggestCorrection — Something else", () => {
  type User = ReturnType<typeof userEvent.setup>;

  async function openDialog(user: User, props: Partial<React.ComponentProps<typeof SuggestCorrection>> = {}) {
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" {...props} />);
    await user.click(screen.getByRole("button", { name: /suggest a correction|know/i }));
  }

  function fetchCall() {
    const mockFetch = global.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
    const [url, init] = mockFetch.mock.calls[0];
    return { url, body: JSON.parse(init.body as string) as Record<string, unknown> };
  }

  async function fillTip(user: User, text = "the build was cancelled") {
    await user.type(screen.getByLabelText(/what should we know/i), text);
    await user.type(screen.getByLabelText(/source url/i), "example.com/x");
  }

  const send = (user: User) => user.click(screen.getByRole("button", { name: /send for review/i }));

  it("is the last option in the field select", async () => {
    const user = userEvent.setup();
    await openDialog(user);

    await user.click(screen.getByRole("combobox", { name: /what.s wrong/i }));
    const options = await screen.findAllByRole("option");

    expect(options[options.length - 1]).toHaveTextContent("Something else");
  });

  it("swaps the value field and the Currently line for a required textarea", async () => {
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "name", currentValues: { name: "Colossus" } });
    expect(screen.getByText("Currently: Colossus")).toBeInTheDocument();
    expect(screen.getByLabelText(/new value/i)).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: /what.s wrong/i }));
    await user.click(await screen.findByRole("option", { name: "Something else" }));

    expect(screen.queryByLabelText(/new value/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/currently:/i)).not.toBeInTheDocument();
    const textarea = screen.getByLabelText(/what should we know/i);
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea).toHaveAttribute("maxlength", "400");
    expect(textarea).toBeRequired();
    expect(screen.getByRole("button", { name: /send for review/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /submit correction/i })).not.toBeInTheDocument();
  });

  it("keeps Source URL and the name field, but drops the optional Note (the textarea replaces it)", async () => {
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "other" });
    await user.click(screen.getByText("Add your name (optional)"));

    expect(screen.getByLabelText(/source url/i)).toBeRequired();
    expect(screen.getByLabelText(/name or handle/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^note/i)).not.toBeInTheDocument();
  });

  it("blocks empty text, says why, and puts focus on the textarea", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "other" });
    await user.type(screen.getByLabelText(/source url/i), "https://example.com/x");

    await send(user);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Tell us what to look into.")).toHaveAttribute("role", "alert");
    const textarea = screen.getByLabelText(/what should we know/i);
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    expect(textarea).toHaveAccessibleDescription("Tell us what to look into.");
    expect(textarea).toHaveFocus();
  });

  it("still requires a source, and posts nothing without one", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "other" });
    await user.type(screen.getByLabelText(/what should we know/i), "the build was cancelled");

    await send(user);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Add a link to a public source.")).toBeInTheDocument();
    expect(screen.getByLabelText(/source url/i)).toHaveFocus();
  });

  it("posts a tip to /api/leads, not /api/contribute, with the lead body", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "other" });
    await fillTip(user);
    await user.click(screen.getByText("Add your name (optional)"));
    await user.type(screen.getByLabelText(/name or handle/i), "jdoe");

    await send(user);

    await screen.findByText(/we.ll look into it/i);
    const { url, body } = fetchCall();
    expect(url).toBe("/api/leads");
    expect(body).toEqual({
      url: "https://example.com/x",
      note: "Test DC: the build was cancelled",
      website: "",
      attribution: "jdoe",
    });
  });

  it("still posts an ordinary correction to /api/contribute", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "name" });
    await user.type(screen.getByLabelText(/new value/i), "Colossus");
    await user.type(screen.getByLabelText(/source url/i), "https://example.com/x");

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    await screen.findByText(/your correction is in the review queue/i);
    const { url, body } = fetchCall();
    expect(url).toBe("/api/contribute");
    expect(body.field).toBe("name");
  });

  it("shows the tip success view, moves focus to it, and closes on Done", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "other" });
    await fillTip(user);

    await send(user);

    const thanks = await screen.findByText(
      /we.ll look into it\. tips are researched before anything is published\./i
    );
    expect(thanks).toHaveAttribute("role", "alert");
    expect(thanks).toHaveFocus();
    expect(screen.queryByText(/review queue/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /public activity feed/i })).toHaveAttribute(
      "href",
      "/activity"
    );

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText(/we.ll look into it/i)).not.toBeInTheDocument();
  });

  it("maps a 400 'url' issue to the source field, in friendly words", async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Invalid lead",
        issues: [{ path: ["url"], message: "Invalid URL" }],
      }),
    });
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "other" });
    await fillTip(user);

    await send(user);

    expect(await screen.findByText("Paste the full link, starting with https://")).toBeInTheDocument();
    expect(screen.getByLabelText(/source url/i)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Please fix the errors below.")).toBeInTheDocument();
    expect(screen.queryByText("Invalid lead")).not.toBeInTheDocument();
  });

  it("maps a 400 'note' issue to the textarea", async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Invalid lead",
        issues: [{ path: ["note"], message: "Too long for a tip" }],
      }),
    });
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "other" });
    await fillTip(user);

    await send(user);

    expect(await screen.findByText("Too long for a tip")).toBeInTheDocument();
    expect(screen.getByLabelText(/what should we know/i)).toHaveAttribute("aria-invalid", "true");
  });

  it("shows the server's message on a 429", async () => {
    mockFetchOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: "Too many submissions. Please try again later." }),
    });
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "other" });
    await fillTip(user);

    await send(user);

    expect(await screen.findByText("Too many submissions. Please try again later.")).toBeInTheDocument();
  });

  it("falls back to a generic message for any other failure", async () => {
    mockFetchOnce({ ok: false, status: 503, json: async () => ({ error: "down" }) });
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "other" });
    await fillTip(user);

    await send(user);

    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
  });

  it("uses the topic as the placeholder and in the note", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "other", topic: "the investment amount" });
    expect(screen.getByLabelText(/what should we know/i)).toHaveAttribute(
      "placeholder",
      "e.g. the investment amount, and where you saw it"
    );
    await fillTip(user, "about $2B");

    await send(user);

    await screen.findByText(/we.ll look into it/i);
    expect(fetchCall().body.note).toBe("Test DC — the investment amount: about $2B");
  });

  it("has no placeholder without a topic", async () => {
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "other" });

    expect(screen.getByLabelText(/what should we know/i)).not.toHaveAttribute("placeholder");
  });

  it("titles the optional section for a name only, since the Note is gone", async () => {
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "other" });

    expect(screen.getByText("Add your name (optional)")).toBeInTheDocument();
    expect(screen.queryByText("Add a note or credit (optional)")).not.toBeInTheDocument();
  });

  it("keeps the note-or-credit title for an ordinary correction", async () => {
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "name" });

    expect(screen.getByText("Add a note or credit (optional)")).toBeInTheDocument();
    expect(screen.queryByText("Add your name (optional)")).not.toBeInTheDocument();
  });

  it("carries a Note typed before switching into the textarea, and clears the Note", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "name" });
    await user.click(screen.getByText("Add a note or credit (optional)"));
    await user.type(screen.getByLabelText(/^note/i), "saw it in the county minutes");

    await user.click(screen.getByRole("combobox", { name: /what.s wrong/i }));
    await user.click(await screen.findByRole("option", { name: "Something else" }));

    expect(screen.getByLabelText(/what should we know/i)).toHaveValue("saw it in the county minutes");
    expect(screen.queryByLabelText(/^note/i)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/source url/i), "https://example.com/x");
    await send(user);
    await screen.findByText(/we.ll look into it/i);
    expect(fetchCall().body.note).toBe("Test DC: saw it in the county minutes");
  });

  it("leaves the textarea empty when no Note was typed", async () => {
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "name" });

    await user.click(screen.getByRole("combobox", { name: /what.s wrong/i }));
    await user.click(await screen.findByRole("option", { name: "Something else" }));

    expect(screen.getByLabelText(/what should we know/i)).toHaveValue("");
  });

  it("does not bring a stale Note back when switching to a correctable field", async () => {
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "name" });
    await user.click(screen.getByText("Add a note or credit (optional)"));
    await user.type(screen.getByLabelText(/^note/i), "a note");
    await user.click(screen.getByRole("combobox", { name: /what.s wrong/i }));
    await user.click(await screen.findByRole("option", { name: "Something else" }));

    await user.click(screen.getByRole("combobox", { name: /what.s wrong/i }));
    await user.click(await screen.findByRole("option", { name: "Operator" }));

    expect(screen.getByLabelText(/^note/i)).toHaveValue("");
  });

  it("limits the source link to the server's 2000 characters", async () => {
    const user = userEvent.setup();
    await openDialog(user, { defaultField: "other" });

    expect(screen.getByLabelText(/source url/i)).toHaveAttribute("maxlength", "2000");
  });
});

describe("SuggestCorrection — Enter in the source field", () => {
  // Enter submits without blurring, so the submit itself must normalise the
  // link. A 400 keeps the form on screen so the field can be read afterwards.
  it("shows the https:// that was sent", async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "Please fix the errors below.", issues: [] }),
    });
    const user = userEvent.setup();
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" />);
    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));
    await user.type(screen.getByLabelText(/new value/i), "Colossus");

    await user.type(screen.getByLabelText(/source url/i), "example.com/x{Enter}");

    await screen.findByText("Please fix the errors below.");
    expect(screen.getByLabelText(/source url/i)).toHaveValue("https://example.com/x");
    const mockFetch = global.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
    expect(JSON.parse(mockFetch.mock.calls[0][1].body as string).sourceUrl).toBe(
      "https://example.com/x"
    );
  });
});

// ---------------------------------------------------------------------------
// Lengths the server enforces: nothing is ever cut silently.
// ---------------------------------------------------------------------------

describe("validateCorrection — lengths", () => {
  const other: CorrectionFormState = {
    field: "other",
    value: "x",
    sourceUrl: "https://example.com/source",
    attribution: "",
    note: "",
    notifyEmail: "",
    website: "",
  };

  it("accepts a tip of exactly 400 characters, ignoring surrounding spaces", () => {
    expect(validateCorrection({ ...other, value: `  ${"x".repeat(400)}  ` })).toEqual({});
  });

  it("rejects a tip over 400 characters instead of cutting it", () => {
    expect(validateCorrection({ ...other, value: "x".repeat(401) })).toEqual({
      value: "Keep it to 400 characters or fewer.",
    });
  });

  // "https://" is added, so a link that fits the input can cross 2000 after it.
  it("rejects a link that is over 2000 characters once https:// is added", () => {
    const bare = `example.com/${"a".repeat(1983)}`; // 1995 typed, 2003 sent
    expect(bare).toHaveLength(1995);
    expect(validateCorrection({ ...other, sourceUrl: bare })).toEqual({
      sourceUrl: "That link is too long.",
    });
  });

  it("accepts a link that comes to exactly 2000 once https:// is added", () => {
    const bare = `example.com/${"a".repeat(1980)}`; // 1992 typed, 2000 sent
    expect(validateCorrection({ ...other, sourceUrl: bare })).toEqual({});
  });

  it("rejects an over-long link on an ordinary correction too", () => {
    expect(
      validateCorrection({
        ...other,
        field: "name",
        sourceUrl: `https://example.com/${"a".repeat(2000)}`,
      })
    ).toEqual({ sourceUrl: "That link is too long." });
  });
});

describe("SuggestCorrection — lengths in the dialog", () => {
  type User = ReturnType<typeof userEvent.setup>;

  async function openDialog(user: User, defaultField: CorrectableKey | "other") {
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" defaultField={defaultField} />);
    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));
  }

  it("carries a 2,000-character Note whole, then refuses it on submit rather than cutting it", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const user = userEvent.setup();
    await openDialog(user, "name");
    await user.click(screen.getByText("Add a note or credit (optional)"));
    await user.click(screen.getByLabelText(/^note/i));
    await user.paste("n".repeat(2000));

    await user.click(screen.getByRole("combobox", { name: /what.s wrong/i }));
    await user.click(await screen.findByRole("option", { name: "Something else" }));

    const textarea = screen.getByLabelText(/what should we know/i);
    expect(textarea).toHaveValue("n".repeat(2000));

    await user.type(screen.getByLabelText(/source url/i), "https://example.com/x");
    await user.click(screen.getByRole("button", { name: /send for review/i }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Keep it to 400 characters or fewer.")).toBeInTheDocument();
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    expect(textarea).toHaveFocus();
  });

  it("lets the person trim a carried Note and send it", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openDialog(user, "name");
    await user.click(screen.getByText("Add a note or credit (optional)"));
    await user.click(screen.getByLabelText(/^note/i));
    await user.paste("n".repeat(500));
    await user.click(screen.getByRole("combobox", { name: /what.s wrong/i }));
    await user.click(await screen.findByRole("option", { name: "Something else" }));
    await user.type(screen.getByLabelText(/source url/i), "https://example.com/x");

    await user.clear(screen.getByLabelText(/what should we know/i));
    await user.type(screen.getByLabelText(/what should we know/i), "short and sourced");
    await user.click(screen.getByRole("button", { name: /send for review/i }));

    await screen.findByText(/we.ll look into it/i);
    const mockFetch = global.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
    expect(JSON.parse(mockFetch.mock.calls[0][1].body as string).note).toBe(
      "Test DC: short and sourced"
    );
  });

  it("blocks a link that is too long once https:// is added, and focuses it", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const user = userEvent.setup();
    await openDialog(user, "name");
    await user.type(screen.getByLabelText(/new value/i), "Colossus");
    await user.click(screen.getByLabelText(/source url/i));
    await user.paste(`example.com/${"a".repeat(1983)}`); // 1995 typed

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText("That link is too long.")).toBeInTheDocument();
    const source = screen.getByLabelText(/source url/i);
    expect(source).toHaveAttribute("aria-invalid", "true");
    expect(source).toHaveAccessibleDescription(/That link is too long\./);
    expect(source).toHaveFocus();
  });
});

// ---------------------------------------------------------------------------
// "No link?" — every staged item stays source-cited, so someone without a link
// is sent to the contact form, which prefills from these two params.
// ---------------------------------------------------------------------------

describe("SuggestCorrection — no-link contact fallback", () => {
  const NAME = "Smith & Sons DC #2";

  async function openDialog(defaultField?: CorrectableKey | "other") {
    const user = userEvent.setup();
    render(<SuggestCorrection facilityId="facility-1" facilityName={NAME} defaultField={defaultField} />);
    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));
    return user;
  }

  it("links to the contact form with the facility name URI-encoded", async () => {
    await openDialog();

    const link = screen.getByRole("link", { name: "No link? Tell us through the contact form" });
    expect(link).toHaveAttribute(
      "href",
      "/contact?topic=correction&about=Smith%20%26%20Sons%20DC%20%232"
    );
  });

  it("is a contract with /contact: its own prefill reads the same topic and facility back", async () => {
    await openDialog();

    const href = screen
      .getByRole("link", { name: /no link\?/i })
      .getAttribute("href") as string;
    const search = href.slice(href.indexOf("?"));
    const prefilled = applyPrefill(
      { name: "", email: "", topic: "", message: "", website: "" },
      search
    );

    expect(prefilled.topic).toBe("correction");
    expect(prefilled.message).toBe(`About ${NAME}: `);
  });

  it("sits right under the source hint", async () => {
    await openDialog();

    const hint = screen.getByText(/where did you see it\?/i);
    const link = screen.getByRole("link", { name: /no link\?/i });
    expect(hint.nextElementSibling).toContainElement(link);
  });

  it("is offered for 'Something else' too, where a source is also required", async () => {
    await openDialog("other");

    expect(screen.getByRole("link", { name: /no link\?/i })).toHaveAttribute(
      "href",
      expect.stringContaining("about=Smith%20%26%20Sons")
    );
  });
});

// ---------------------------------------------------------------------------
// Notify email — optional, correction mode only, behind the server-read flag.
// ---------------------------------------------------------------------------

describe("notify email payload rules", () => {
  const base: CorrectionFormState = {
    field: "operator",
    value: "New Operator LLC",
    sourceUrl: "https://example.com/press-release",
    attribution: "",
    note: "",
    notifyEmail: "  a@b.co  ",
    website: "",
  };

  it("omits notifyEmail when the flag is off", () => {
    expect(buildCorrectionPayload("f-1", base)).not.toHaveProperty("notifyEmail");
    expect(buildCorrectionPayload("f-1", base, false)).not.toHaveProperty("notifyEmail");
  });

  it("sends the trimmed notifyEmail when the flag is on", () => {
    expect(buildCorrectionPayload("f-1", base, true).notifyEmail).toBe("a@b.co");
  });

  it("omits a whitespace-only notifyEmail even when the flag is on", () => {
    expect(buildCorrectionPayload("f-1", { ...base, notifyEmail: "   " }, true)).not.toHaveProperty(
      "notifyEmail"
    );
  });

  it("never puts notifyEmail in a lead tip", () => {
    expect(buildLeadTipPayload("Test DC", { ...base, field: "other", value: "tip" })).not.toHaveProperty(
      "notifyEmail"
    );
  });
});

describe("SuggestCorrection — notify email", () => {
  type User = ReturnType<typeof userEvent.setup>;

  async function openDialog(user: User, enabled?: boolean) {
    const dialog = <SuggestCorrection facilityId="facility-1" facilityName="Test DC" />;
    render(
      enabled === undefined ? dialog : (
        <CorrectionNotifyProvider enabled={enabled}>{dialog}</CorrectionNotifyProvider>
      )
    );
    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));
  }

  async function fillRequired(user: User) {
    await user.type(screen.getByLabelText(/new value/i), "Acme Operator");
    await user.type(screen.getByLabelText(/source url/i), "https://example.com/source");
  }

  function fetchCall() {
    const mockFetch = global.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
    const [url, init] = mockFetch.mock.calls[0];
    return { url, body: JSON.parse(init.body as string) as Record<string, unknown> };
  }

  const submit = (user: User) => user.click(screen.getByRole("button", { name: /submit correction/i }));

  it("shows no email field without a provider", async () => {
    const user = userEvent.setup();
    await openDialog(user);
    await user.click(screen.getByText(/add a note or credit/i));
    expect(screen.queryByLabelText(/your email/i)).not.toBeInTheDocument();
  });

  it("shows no email field when the provider is disabled", async () => {
    const user = userEvent.setup();
    await openDialog(user, false);
    expect(screen.queryByLabelText(/your email/i)).not.toBeInTheDocument();
  });

  it("shows a described email field, and a matching summary, when enabled", async () => {
    const user = userEvent.setup();
    await openDialog(user, true);
    expect(screen.getByText(/add a note, credit or email \(optional\)/i)).toBeInTheDocument();
    const input = screen.getByLabelText(/your email \(optional\)/i);
    expect(input).toHaveAttribute("type", "email");
    expect(input).toHaveAccessibleDescription(/email you once when this is reviewed/i);
  });

  it("drops the field for Something else", async () => {
    const user = userEvent.setup();
    await openDialog(user, true);
    await user.click(screen.getByRole("combobox", { name: /what.s wrong/i }));
    await user.click(await screen.findByRole("option", { name: "Something else" }));
    expect(screen.queryByLabelText(/your email/i)).not.toBeInTheDocument();
    expect(screen.getByText("Add your name (optional)")).toBeInTheDocument();
  });

  it("posts the trimmed email to /api/contribute", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openDialog(user, true);
    await fillRequired(user);
    await user.type(screen.getByLabelText(/your email/i), " a@b.co ");
    await submit(user);
    await screen.findByText(/your correction is in the review queue/i);
    const { url, body } = fetchCall();
    expect(url).toBe("/api/contribute");
    expect(body.notifyEmail).toBe("a@b.co");
  });

  it("omits the key when no email was typed", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openDialog(user, true);
    await fillRequired(user);
    await submit(user);
    await screen.findByText(/your correction is in the review queue/i);
    expect(fetchCall().body).not.toHaveProperty("notifyEmail");
  });

  it("does not send a previously typed email on a Something else submit", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openDialog(user, true);
    await user.type(screen.getByLabelText(/your email/i), "a@b.co");
    await user.click(screen.getByRole("combobox", { name: /what.s wrong/i }));
    await user.click(await screen.findByRole("option", { name: "Something else" }));
    await user.type(screen.getByLabelText(/what should we know/i), "the build was cancelled");
    await user.type(screen.getByLabelText(/source url/i), "example.com/x");
    await user.click(screen.getByRole("button", { name: /send for review/i }));
    await screen.findByText(/we.ll look into it/i);
    const { url, body } = fetchCall();
    expect(url).toBe("/api/leads");
    expect(body).not.toHaveProperty("notifyEmail");
  });

  it("opens the disclosure, softens the message and focuses the input on a 400 for the email", async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Invalid notify email",
        issues: [{ path: ["notifyEmail"], message: "Invalid email address" }],
      }),
    });
    const user = userEvent.setup();
    await openDialog(user, true);
    await fillRequired(user);
    await user.type(screen.getByLabelText(/your email/i), "nope");
    const details = screen.getByText(/add a note, credit or email/i).closest("details");
    expect(details).not.toHaveAttribute("open");
    await submit(user);
    expect(await screen.findByText("Check the email address, or leave it blank.")).toBeInTheDocument();
    expect(details).toHaveAttribute("open");
    expect(screen.getByLabelText(/your email/i)).toHaveFocus();
    const formError = "Check the email address under “Add a note, credit or email”.";
    expect(screen.getByText(formError)).toBeInTheDocument();
    expect(screen.queryByText("Invalid notify email")).not.toBeInTheDocument();
    // Collapsing the disclosure hides the field error; the form error must still say where to look.
    await user.click(screen.getByText(/add a note, credit or email \(optional\)/i));
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText(formError)).toBeInTheDocument();
  });

  it("drops the no-status sentence only when an email was sent", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openDialog(user, true);
    await fillRequired(user);
    await user.type(screen.getByLabelText(/your email/i), "a@b.co");
    await submit(user);
    await screen.findByText(/your correction is in the review queue/i);
    expect(screen.queryByText(/no status to track/i)).not.toBeInTheDocument();
    const para = screen.getByRole("link", { name: /public activity feed/i }).closest("p")!;
    expect(para.textContent!.replace(/\s+/g, " ").trim()).toMatch(/public activity feed\.$/);
  });

  it("keeps the no-status sentence when no email was sent", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openDialog(user, true);
    await fillRequired(user);
    await submit(user);
    await screen.findByText(/your correction is in the review queue/i);
    expect(screen.getByText(/no status to track/i)).toBeInTheDocument();
    const para = screen.getByText(/no status to track/i).closest("p")!;
    expect(para.textContent!.replace(/\s+/g, " ").trim()).toMatch(
      /public activity feed\. Submissions are anonymous, so there\u2019s no status to track this one\.$/
    );
  });
});
