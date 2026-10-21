import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Flag } from "lucide-react";

import { CORRECTABLE_FIELD_META, type CorrectableKey } from "@/lib/contribute-fields";

import {
  SuggestCorrection,
  buildCorrectionPayload,
  currentValueFor,
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
