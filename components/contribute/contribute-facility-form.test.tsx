import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ContributeFacilityForm } from "./contribute-facility-form";

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
