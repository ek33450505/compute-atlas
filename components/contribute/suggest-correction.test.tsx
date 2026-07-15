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

  it("opens the dialog with the facility name and form fields on trigger click", async () => {
    const user = userEvent.setup();
    render(<SuggestCorrection facilityId="facility-1" facilityName="Test DC" />);

    await user.click(screen.getByRole("button", { name: /suggest a correction/i }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Test DC")).toBeInTheDocument();
    expect(screen.getByLabelText(/what.s wrong/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/source url/i)).toBeInTheDocument();
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

  it("surfaces the server error message on 400", async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "Invalid value", issues: [{ path: ["value"], message: "too short" }] }),
    });
    const user = userEvent.setup();
    await openAndFillSourceUrl(user);

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid value/i);
  });

  it("surfaces a generic message on network failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const user = userEvent.setup();
    await openAndFillSourceUrl(user);

    await user.click(screen.getByRole("button", { name: /submit correction/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/something went wrong/i);
  });
});
