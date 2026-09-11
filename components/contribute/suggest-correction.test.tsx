import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  SuggestCorrection,
  buildCorrectionPayload,
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
        trigger={<button type="button">Know operator?</button>}
      />
    );

    expect(
      screen.getByRole("button", { name: /know operator\?/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^suggest a correction$/i })
    ).not.toBeInTheDocument();
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
    await user.type(screen.getByLabelText(/name or handle/i), "jdoe");

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    await screen.findByText(/your correction is in the review queue/i);

    const mockFetch = global.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
    const [, init] = mockFetch.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.attribution).toBe("jdoe");
  });
});
