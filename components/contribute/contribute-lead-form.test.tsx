import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ContributeLeadForm } from "./contribute-lead-form";

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetchOnce(response: { ok: boolean; status: number; json: () => Promise<unknown> }) {
  global.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

function getPostedBody(): Record<string, unknown> {
  const mockFetch = global.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
  const [, init] = mockFetch.mock.calls[0];
  return JSON.parse(init.body as string);
}

// Clear the module-scoped `global.fetch` mock between tests — an uncleared
// mock can match a prior test's call and hide a real bug (this repo has hit
// that exact class of flake before).
beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Rendered structure
// ---------------------------------------------------------------------------

describe("ContributeLeadForm — structure", () => {
  it("renders the URL and note fields with accessible names, plus the submit button", () => {
    render(<ContributeLeadForm />);

    expect(screen.getByLabelText(/link to a source/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/what is it/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/name or handle/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit link/i })).toBeInTheDocument();
  });

  it("keeps the honeypot out of the tab order and hidden from assistive tech", () => {
    const { container } = render(<ContributeLeadForm />);

    const honeypot = container.querySelector('input[id="leadWebsite"]');
    expect(honeypot).toHaveAttribute("tabindex", "-1");

    const honeypotWrapper = honeypot?.closest("div");
    expect(honeypotWrapper).toHaveAttribute("aria-hidden", "true");
  });
});

// ---------------------------------------------------------------------------
// Submit outcomes (mocked fetch)
// ---------------------------------------------------------------------------

describe("ContributeLeadForm — submit outcomes", () => {
  it("submits the URL alone (no note) and POSTs the right body to /api/leads", async () => {
    const user = userEvent.setup();
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });

    render(<ContributeLeadForm />);
    await user.type(screen.getByLabelText(/link to a source/i), "https://example.com/article");
    await user.click(screen.getByRole("button", { name: /submit link/i }));

    await screen.findByText(/in the queue/i);

    const [url, init] = (global.fetch as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0];
    expect(url).toBe("/api/leads");
    expect(init.method).toBe("POST");
    expect(getPostedBody()).toEqual({
      url: "https://example.com/article",
      website: "",
    });
  });

  it("includes a trimmed note and attribution in the payload when provided", async () => {
    const user = userEvent.setup();
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });

    render(<ContributeLeadForm />);
    await user.type(screen.getByLabelText(/link to a source/i), "https://example.com/article");
    await user.type(screen.getByLabelText(/what is it/i), "  New DC proposed  ");
    await user.type(screen.getByLabelText(/name or handle/i), "  jdoe  ");
    await user.click(screen.getByRole("button", { name: /submit link/i }));

    await screen.findByText(/in the queue/i);
    const body = getPostedBody();
    expect(body.note).toBe("New DC proposed");
    expect(body.attribution).toBe("jdoe");
  });

  it("shows the queued confirmation and a reset button on success (201), and moves focus to it", async () => {
    const user = userEvent.setup();
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });

    render(<ContributeLeadForm />);
    await user.type(screen.getByLabelText(/link to a source/i), "https://example.com/article");
    await user.click(screen.getByRole("button", { name: /submit link/i }));

    const confirmation = await screen.findByText(/in the queue/i);
    expect(confirmation).toHaveAttribute("role", "alert");
    expect(confirmation).toHaveFocus();
    expect(screen.getByRole("button", { name: /submit another/i })).toBeInTheDocument();
  });

  it("resets to the empty form when 'Submit another' is clicked", async () => {
    const user = userEvent.setup();
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });

    render(<ContributeLeadForm />);
    await user.type(screen.getByLabelText(/link to a source/i), "https://example.com/article");
    await user.click(screen.getByRole("button", { name: /submit link/i }));
    await screen.findByText(/in the queue/i);

    await user.click(screen.getByRole("button", { name: /submit another/i }));

    expect(screen.getByLabelText(/link to a source/i)).toHaveValue("");
    expect(screen.getByRole("button", { name: /submit link/i })).toBeInTheDocument();
  });

  it("surfaces a field-level error from a 400 response's issues array, next to the right input", async () => {
    const user = userEvent.setup();
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Invalid lead",
        issues: [{ path: ["url"], message: "url must use the http or https protocol" }],
      }),
    });

    render(<ContributeLeadForm />);
    await user.type(screen.getByLabelText(/link to a source/i), "javascript:alert(1)");
    await user.click(screen.getByRole("button", { name: /submit link/i }));

    const message = await screen.findByText("url must use the http or https protocol");
    expect(message).toBeInTheDocument();
    expect(message).toHaveAttribute("role", "alert");
    expect(screen.getByLabelText(/link to a source/i)).toHaveAttribute("aria-invalid", "true");
  });

  it("surfaces the rate-limit message from a 429 response", async () => {
    const user = userEvent.setup();
    mockFetchOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: "Too many submissions. Please try again later." }),
    });

    render(<ContributeLeadForm />);
    await user.type(screen.getByLabelText(/link to a source/i), "https://example.com/article");
    await user.click(screen.getByRole("button", { name: /submit link/i }));

    expect(
      await screen.findByText(/too many submissions\. please try again later\./i)
    ).toBeInTheDocument();
  });
});
