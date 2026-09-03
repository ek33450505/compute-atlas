import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AccessRequestForm } from "./access-request-form";

// next/link renders to <a> — mock to avoid Next.js router-context dependency
// in jsdom (same pattern as components/contact/contact-form.test.tsx).
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => (
    <a href={href} className={className} {...rest}>
      {children}
    </a>
  ),
}));

function mockFetchOnce(response: { ok: boolean; status: number; json: () => Promise<unknown> }) {
  global.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
}

function getPostedBody(): Record<string, unknown> {
  const mockFetch = global.fetch as unknown as { mock: { calls: [string, RequestInit][] } };
  const [, init] = mockFetch.mock.calls[0];
  return JSON.parse(init.body as string);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AccessRequestForm — structure", () => {
  it("renders the email field with an accessible name, plus the submit button", () => {
    render(<AccessRequestForm />);

    expect(screen.getByLabelText(/^email/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /request access/i })).toBeInTheDocument();
  });

  it("keeps the honeypot out of the tab order and hidden from assistive tech", () => {
    const { container } = render(<AccessRequestForm />);

    const honeypot = container.querySelector('input[id="accessWebsite"]');
    expect(honeypot).toHaveAttribute("tabindex", "-1");
    expect(honeypot?.closest("div")).toHaveAttribute("aria-hidden", "true");
  });

  it("links to /data for a one-time download", () => {
    render(<AccessRequestForm />);
    expect(screen.getByRole("link", { name: "Get the data" })).toHaveAttribute("href", "/data");
  });
});

describe("AccessRequestForm — submit outcomes", () => {
  it("POSTs the trimmed email to /api/access/request", async () => {
    const user = userEvent.setup();
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });

    render(<AccessRequestForm />);
    await user.type(screen.getByLabelText(/^email/i), "  reader@example.com  ");
    await user.click(screen.getByRole("button", { name: /request access/i }));

    await screen.findByText(/check your inbox/i);

    const [url, init] = (global.fetch as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0];
    expect(url).toBe("/api/access/request");
    expect(init.method).toBe("POST");
    expect(getPostedBody()).toEqual({ email: "reader@example.com", website: "" });
  });

  it("shows a success message on 201 that says the token is shown once", async () => {
    const user = userEvent.setup();
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });

    render(<AccessRequestForm />);
    await user.type(screen.getByLabelText(/^email/i), "reader@example.com");
    await user.click(screen.getByRole("button", { name: /request access/i }));

    const confirmation = await screen.findByText(/check your inbox/i);
    expect(confirmation).toHaveAttribute("role", "alert");
    expect(screen.getByText(/shown once/i)).toBeInTheDocument();
  });

  it("surfaces a field-level error from a 400 response's issues array", async () => {
    const user = userEvent.setup();
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Invalid request",
        issues: [{ path: ["email"], message: "Invalid email" }],
      }),
    });

    render(<AccessRequestForm />);
    await user.type(screen.getByLabelText(/^email/i), "not-an-email");
    await user.click(screen.getByRole("button", { name: /request access/i }));

    const message = await screen.findByText("Invalid email");
    expect(message).toHaveAttribute("role", "alert");
    expect(screen.getByLabelText(/^email/i)).toHaveAttribute("aria-invalid", "true");
  });

  it("surfaces the rate-limit message from a 429 response", async () => {
    const user = userEvent.setup();
    mockFetchOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: "Too many requests. Please try again later." }),
    });

    render(<AccessRequestForm />);
    await user.type(screen.getByLabelText(/^email/i), "reader@example.com");
    await user.click(screen.getByRole("button", { name: /request access/i }));

    expect(
      await screen.findByText(/too many requests\. please try again later\./i)
    ).toBeInTheDocument();
  });

  it("disables the submit button while a request is in flight", async () => {
    const user = userEvent.setup();
    let resolveFetch: (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void;
    global.fetch = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    ) as unknown as typeof fetch;

    render(<AccessRequestForm />);
    await user.type(screen.getByLabelText(/^email/i), "reader@example.com");
    const submitButton = screen.getByRole("button", { name: /request access/i });
    await user.click(submitButton);

    expect(submitButton).toBeDisabled();

    resolveFetch!({ ok: true, status: 201, json: async () => ({ ok: true }) });
    await screen.findByText(/check your inbox/i);
  });
});
