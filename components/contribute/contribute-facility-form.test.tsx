import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ContributeFacilityForm, buildContributePayload } from "./contribute-facility-form";

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetchOnce(response: { ok: boolean; status: number; json: () => Promise<unknown> }) {
  global.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Fills every field required for a valid submission (state is left at its
 * default/unselected value — the Base UI Select popup is portaled/async and
 * isn't needed for these fetch-outcome assertions). */
async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^name/i), "New DC");
  await user.type(screen.getByLabelText(/^operator/i), "New Op");
  await user.type(screen.getByLabelText(/latitude/i), "30");
  await user.type(screen.getByLabelText(/longitude/i), "-90");
  await user.type(screen.getByLabelText(/source url/i), "https://example.com/press-release");
}

// ---------------------------------------------------------------------------
// Rendered structure
// ---------------------------------------------------------------------------

describe("ContributeFacilityForm — structure", () => {
  it("renders the required fields and the submit button", () => {
    render(<ContributeFacilityForm />);

    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^operator/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^state/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/latitude/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/longitude/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/source url/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit facility/i })).toBeInTheDocument();
  });

  it("keeps the honeypot out of the tab order (not reachable via Tab/assistive-tech navigation)", () => {
    const { container } = render(<ContributeFacilityForm />);

    // The field lives under an aria-hidden wrapper (verified structurally
    // below) and is also removed from the tab order directly — belt-and-
    // suspenders, since aria-hidden alone doesn't stop keyboard Tab focus.
    const honeypotWrapper = container.querySelector('input[name="website"]')?.closest("div");
    expect(honeypotWrapper).toHaveAttribute("aria-hidden", "true");

    const honeypot = container.querySelector('input[name="website"]');
    expect(honeypot).toHaveAttribute("tabindex", "-1");
  });
});

// ---------------------------------------------------------------------------
// Select labels — Base UI's <SelectValue /> resolves its displayed text from
// the Select root's `items` prop, not from the rendered <SelectItem>
// children; without `items` it falls back to the raw enum value
// (resolveValueLabel.js's `stringifyAsLabel`). Regression coverage for that:
// select an option and assert the trigger shows the human label, not the
// stored value.
// ---------------------------------------------------------------------------

describe("ContributeFacilityForm — select labels", () => {
  it("shows the human label on the Type trigger after selecting an option", async () => {
    const user = userEvent.setup();
    render(<ContributeFacilityForm />);

    await user.click(screen.getByRole("combobox", { name: /^type$/i }));
    await user.click(await screen.findByRole("option", { name: "Crypto mining" }));

    const trigger = screen.getByRole("combobox", { name: /^type$/i });
    expect(trigger).toHaveTextContent("Crypto mining");
    expect(trigger).not.toHaveTextContent("crypto_mining");
  });

  it("shows the human label on the Status trigger after selecting an option", async () => {
    const user = userEvent.setup();
    render(<ContributeFacilityForm />);

    await user.click(screen.getByRole("combobox", { name: /^status$/i }));
    await user.click(await screen.findByRole("option", { name: "Under construction" }));

    const trigger = screen.getByRole("combobox", { name: /^status$/i });
    expect(trigger).toHaveTextContent("Under construction");
    expect(trigger).not.toHaveTextContent("under_construction");
  });

  it("shows the full state name on the State trigger after selecting an option", async () => {
    const user = userEvent.setup();
    render(<ContributeFacilityForm />);

    await user.click(screen.getByRole("combobox", { name: /^state$/i }));
    await user.click(await screen.findByRole("option", { name: "California" }));

    const trigger = screen.getByRole("combobox", { name: /^state$/i });
    expect(trigger).toHaveTextContent("California");
    expect(trigger).not.toHaveTextContent("CA");
  });
});

// ---------------------------------------------------------------------------
// Submit outcomes (mocked fetch)
// ---------------------------------------------------------------------------

describe("ContributeFacilityForm — submit outcomes", () => {
  it("shows the review-queue confirmation and a reset button on success (201)", async () => {
    const user = userEvent.setup();
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });

    render(<ContributeFacilityForm />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: /submit facility/i }));

    expect(await screen.findByText(/in the review queue/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit another/i })).toBeInTheDocument();
  });

  it("sets a review-window expectation and links to the public activity feed on success", async () => {
    const user = userEvent.setup();
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });

    render(<ContributeFacilityForm />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: /submit facility/i }));

    await screen.findByText(/in the review queue/i);
    expect(screen.getByText(/reviewed within about a week/i)).toBeInTheDocument();
    const activityLink = screen.getByRole("link", { name: /public activity feed/i });
    expect(activityLink).toHaveAttribute("href", "/activity");
  });

  it("surfaces a field-level error from a 400 response's issues array", async () => {
    const user = userEvent.setup();
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Invalid submission",
        issues: [{ path: ["name"], message: "Name is required" }],
      }),
    });

    render(<ContributeFacilityForm />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: /submit facility/i }));

    const message = await screen.findByText("Name is required");
    expect(message).toBeInTheDocument();
    expect(message).toHaveAttribute("role", "alert");
  });

  it("surfaces the rate-limit message from a 429 response", async () => {
    const user = userEvent.setup();
    mockFetchOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: "Too many submissions. Please try again later." }),
    });

    render(<ContributeFacilityForm />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: /submit facility/i }));

    expect(
      await screen.findByText(/too many submissions\. please try again later\./i)
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Contributor attribution
// ---------------------------------------------------------------------------

function getPostedBody(): Record<string, unknown> {
  const mockFetch = global.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
  const [, init] = mockFetch.mock.calls[0];
  return JSON.parse(init.body as string);
}

// ---------------------------------------------------------------------------
// Coordinate paste-and-split (B6a) — the manual lat/lon inputs stay usable;
// this is an additive shortcut, not a replacement.
// ---------------------------------------------------------------------------

describe("ContributeFacilityForm — paste coordinates", () => {
  it("populates both latitude and longitude fields from a pasted coordinate string", async () => {
    const user = userEvent.setup();
    render(<ContributeFacilityForm />);

    const latInput = screen.getByLabelText(/latitude/i) as HTMLInputElement;
    const lonInput = screen.getByLabelText(/longitude/i) as HTMLInputElement;
    expect(latInput.value).toBe("");
    expect(lonInput.value).toBe("");

    await user.type(screen.getByLabelText(/paste coordinates/i), "39.51, -98.53");

    expect(latInput.value).toBe("39.51");
    expect(lonInput.value).toBe("-98.53");
    expect(
      await screen.findByText(/filled from pasted coordinates/i)
    ).toBeInTheDocument();
  });

  it("preserves a negative longitude when populating the field (not just when parsing)", async () => {
    const user = userEvent.setup();
    render(<ContributeFacilityForm />);

    await user.type(screen.getByLabelText(/paste coordinates/i), "39.51, -98.53");

    const lonInput = screen.getByLabelText(/longitude/i) as HTMLInputElement;
    expect(lonInput.value.startsWith("-")).toBe(true);
  });

  it("does not overwrite the manual fields while the pasted text is still incomplete", async () => {
    const user = userEvent.setup();
    render(<ContributeFacilityForm />);

    await user.type(screen.getByLabelText(/paste coordinates/i), "39.51");

    const latInput = screen.getByLabelText(/latitude/i) as HTMLInputElement;
    const lonInput = screen.getByLabelText(/longitude/i) as HTMLInputElement;
    expect(latInput.value).toBe("");
    expect(lonInput.value).toBe("");
  });

  it("leaves manual lat/lon entry fully working as a fallback", async () => {
    const user = userEvent.setup();
    render(<ContributeFacilityForm />);

    const latInput = screen.getByLabelText(/latitude/i) as HTMLInputElement;
    const lonInput = screen.getByLabelText(/longitude/i) as HTMLInputElement;
    await user.type(latInput, "30");
    await user.type(lonInput, "-90");

    expect(latInput.value).toBe("30");
    expect(lonInput.value).toBe("-90");
  });
});

describe("ContributeFacilityForm — attribution", () => {
  it("renders an optional attribution field", () => {
    render(<ContributeFacilityForm />);
    expect(screen.getByLabelText(/name or handle/i)).toBeInTheDocument();
  });

  it("includes a trimmed attribution in the submitted payload when provided", async () => {
    const user = userEvent.setup();
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });

    render(<ContributeFacilityForm />);
    await fillRequiredFields(user);
    await user.type(screen.getByLabelText(/name or handle/i), "  jdoe  ");
    await user.click(screen.getByRole("button", { name: /submit facility/i }));

    await screen.findByText(/in the review queue/i);
    expect(getPostedBody().attribution).toBe("jdoe");
  });

  it("omits attribution from the payload when left blank", async () => {
    const user = userEvent.setup();
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });

    render(<ContributeFacilityForm />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: /submit facility/i }));

    await screen.findByText(/in the review queue/i);
    expect(getPostedBody()).not.toHaveProperty("attribution");
  });
});

// ---------------------------------------------------------------------------
// "Email me when reviewed" (C1b, Unit C) — gated by the notifyEnabled prop,
// which app/contribute/page.tsx derives from SUBMISSION_NOTIFY_ENABLED and
// passes down. This component never reads process.env itself.
// ---------------------------------------------------------------------------

// Derives the state-object type from buildContributePayload's own (unexported)
// parameter type rather than importing/duplicating ContributeFormState.
type FormState = Parameters<typeof buildContributePayload>[0];

function baseFormState(overrides: Partial<FormState> = {}): FormState {
  return {
    name: "New DC",
    operator: "New Op",
    state: "CA",
    facilityType: "data_center",
    status: "proposed",
    lat: "30",
    lon: "-90",
    city: "",
    capacityOperationalMw: "",
    capacityPlannedMw: "",
    sourceUrl: "https://example.com/press-release",
    sourceLabel: "",
    attribution: "",
    notifyEmail: "",
    note: "",
    website: "",
    ...overrides,
  };
}

describe("ContributeFacilityForm — notify email (C1b)", () => {
  it("does not render the notify-email field when notifyEnabled is false (the default)", () => {
    render(<ContributeFacilityForm />);
    expect(screen.queryByLabelText(/your email/i)).not.toBeInTheDocument();
  });

  it("omits notifyEmail from buildContributePayload's output when the flag is off, even if state carries a value", () => {
    const payload = buildContributePayload(baseFormState({ notifyEmail: "someone@example.com" }));
    expect(payload).not.toHaveProperty("notifyEmail");
  });

  it("renders the notify-email field, reachable by its accessible label, when notifyEnabled is true", () => {
    render(<ContributeFacilityForm notifyEnabled />);
    expect(screen.getByLabelText(/your email/i)).toBeInTheDocument();
  });

  it("associates the notify-email field with its 'used once, then deleted' description", () => {
    render(<ContributeFacilityForm notifyEnabled />);
    expect(screen.getByLabelText(/your email/i)).toHaveAccessibleDescription(/used once/i);
  });

  it("includes a trimmed notifyEmail in the submitted payload when the flag is on and a value is entered", async () => {
    const user = userEvent.setup();
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });

    render(<ContributeFacilityForm notifyEnabled />);
    await fillRequiredFields(user);
    await user.type(screen.getByLabelText(/your email/i), "  someone@example.com  ");
    await user.click(screen.getByRole("button", { name: /submit facility/i }));

    await screen.findByText(/in the review queue/i);
    expect(getPostedBody().notifyEmail).toBe("someone@example.com");
  });

  it("omits notifyEmail from the submitted payload when the flag is on but the field is left blank", async () => {
    const user = userEvent.setup();
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });

    render(<ContributeFacilityForm notifyEnabled />);
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: /submit facility/i }));

    await screen.findByText(/in the review queue/i);
    expect(getPostedBody()).not.toHaveProperty("notifyEmail");
  });

  it("surfaces a server-side 'Invalid notify email' rejection on the field via issuesToFieldMap", async () => {
    const user = userEvent.setup();
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Invalid notify email",
        // lib/contribute.ts wraps notifyEmailSchema in an object schema
        // before parsing specifically so Zod's issue path is
        // ["notifyEmail"], not [] — issuesToFieldMap needs a non-empty
        // path[0] to attach an error to this field, same as every other
        // field-level error in this form.
        issues: [{ path: ["notifyEmail"], message: "Invalid email address" }],
      }),
    });

    render(<ContributeFacilityForm notifyEnabled />);
    await fillRequiredFields(user);
    await user.type(screen.getByLabelText(/your email/i), "not-an-email");
    await user.click(screen.getByRole("button", { name: /submit facility/i }));

    const message = await screen.findByText("Invalid email address");
    expect(message).toBeInTheDocument();
    expect(message).toHaveAttribute("role", "alert");
  });
});
