import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { WatchButton, buildSubscribePayload } from "./watch-button";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// buildSubscribePayload — pure helper, exercised directly (mirrors
// buildCorrectionPayload's tests in suggest-correction.test.tsx).
// ---------------------------------------------------------------------------

describe("buildSubscribePayload", () => {
  it("builds a payload with a trimmed email", () => {
    const payload = buildSubscribePayload("  jdoe@example.com  ", "facility", "facility-1", "");
    expect(payload).toEqual({
      email: "jdoe@example.com",
      targetType: "facility",
      targetId: "facility-1",
      website: "",
    });
  });

  it("carries an absent targetId through as undefined (dropped by JSON.stringify)", () => {
    const payload = buildSubscribePayload("jdoe@example.com", "all", undefined, "");
    expect(payload.targetId).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("targetId");
  });

  it("carries the honeypot value through untouched", () => {
    const payload = buildSubscribePayload("jdoe@example.com", "state", "TX", "bot-filled-this");
    expect(payload.website).toBe("bot-filled-this");
  });
});

// ---------------------------------------------------------------------------
// Rendered structure / interaction
// ---------------------------------------------------------------------------

describe("WatchButton — structure", () => {
  it("renders only the trigger button until clicked", () => {
    render(<WatchButton targetType="facility" targetId="facility-1" label="Watch this facility" />);

    expect(screen.getByRole("button", { name: "Watch this facility" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^email$/i)).not.toBeInTheDocument();
  });

  it("reveals the email form on trigger click", async () => {
    const user = userEvent.setup();
    render(<WatchButton targetType="facility" targetId="facility-1" label="Watch this facility" />);

    await user.click(screen.getByRole("button", { name: "Watch this facility" }));

    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Watch" })).toBeInTheDocument();
  });

  it("keeps the honeypot out of the tab order", async () => {
    const user = userEvent.setup();
    render(<WatchButton targetType="facility" targetId="facility-1" label="Watch this facility" />);

    await user.click(screen.getByRole("button", { name: "Watch this facility" }));

    const honeypot = document.querySelector('input[name="website"]');
    const honeypotWrapper = honeypot?.closest("div");
    expect(honeypotWrapper).toHaveAttribute("aria-hidden", "true");
    expect(honeypot).toHaveAttribute("tabindex", "-1");
    expect(honeypot).toHaveAttribute("autocomplete", "off");
  });
});

// ---------------------------------------------------------------------------
// Submit outcomes
// ---------------------------------------------------------------------------

function mockFetchOnce(response: { ok: boolean; status: number; json: () => Promise<unknown> }) {
  global.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

async function openAndFillEmail(user: ReturnType<typeof userEvent.setup>) {
  render(<WatchButton targetType="state" targetId="TX" label="Watch Texas" />);
  await user.click(screen.getByRole("button", { name: "Watch Texas" }));
  await user.type(screen.getByLabelText(/^email$/i), "jdoe@example.com");
}

describe("WatchButton — submit outcomes", () => {
  it("shows the confirmation copy on 201", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openAndFillEmail(user);

    await user.click(screen.getByRole("button", { name: "Watch" }));

    expect(
      await screen.findByText(/check your email to confirm your subscription/i)
    ).toBeInTheDocument();
  });

  it("replaces the form with the confirmation copy on success", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openAndFillEmail(user);

    await user.click(screen.getByRole("button", { name: "Watch" }));
    await screen.findByText(/check your email to confirm your subscription/i);

    expect(screen.queryByLabelText(/^email$/i)).not.toBeInTheDocument();
  });

  it("surfaces the server error message on 400 and keeps the form", async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: "Enter a valid email address." }),
    });
    const user = userEvent.setup();
    await openAndFillEmail(user);

    await user.click(screen.getByRole("button", { name: "Watch" }));

    expect(await screen.findByText(/enter a valid email address/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^email$/i)).toBeInTheDocument();
  });

  it("surfaces the rate-limit message on 429", async () => {
    mockFetchOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: "Too many subscriptions. Please try again later." }),
    });
    const user = userEvent.setup();
    await openAndFillEmail(user);

    await user.click(screen.getByRole("button", { name: "Watch" }));

    expect(await screen.findByText(/too many subscriptions/i)).toBeInTheDocument();
  });

  it("surfaces a generic message on network failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    const user = userEvent.setup();
    await openAndFillEmail(user);

    await user.click(screen.getByRole("button", { name: "Watch" }));

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
  });

  it("disables the input and submit button while submitting", async () => {
    let resolveFetch!: (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void;
    global.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })
    ) as unknown as typeof fetch;
    const user = userEvent.setup();
    await openAndFillEmail(user);

    await user.click(screen.getByRole("button", { name: "Watch" }));

    expect(screen.getByRole("button", { name: "Watching…" })).toBeDisabled();
    expect(screen.getByLabelText(/^email$/i)).toBeDisabled();

    resolveFetch({ ok: true, status: 201, json: async () => ({ ok: true }) });
    await screen.findByText(/check your email to confirm your subscription/i);
  });

  it("sends targetType and targetId in the POST body", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    await openAndFillEmail(user);

    await user.click(screen.getByRole("button", { name: "Watch" }));
    await screen.findByText(/check your email to confirm your subscription/i);

    const mockFetch = global.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/subscribe");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      email: "jdoe@example.com",
      targetType: "state",
      targetId: "TX",
      website: "",
    });
  });
});
