import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ContactForm } from "./contact-form";

// next/link renders to <a> — mock to avoid Next.js router-context dependency
// in jsdom (same pattern as components/site-footer.test.tsx).
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

/** Fills every field required for a valid submission, including selecting a
 * topic — the form now blocks submission client-side when no topic is
 * chosen (see the "no topic selected" test below), so this must select one
 * for the other submit-outcome tests to actually reach fetch(). */
async function fillRequiredTextFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^name/i), "Jane Reporter");
  await user.type(screen.getByLabelText(/^email/i), "jane@example.com");
  await user.click(screen.getByRole("combobox", { name: /topic/i }));
  await user.click(await screen.findByRole("option", { name: "Press inquiry" }));
  await user.type(
    screen.getByLabelText(/^message/i),
    "I'm writing a story about data center siting and would like to talk."
  );
}

// ---------------------------------------------------------------------------
// Rendered structure
// ---------------------------------------------------------------------------

describe("ContactForm — structure", () => {
  it("renders the name, email, topic, and message fields with accessible names, plus the submit button", () => {
    render(<ContactForm />);

    expect(screen.getByLabelText(/^name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^email/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /topic/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^message/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send message/i })).toBeInTheDocument();
  });

  it("keeps the honeypot out of the tab order and hidden from assistive tech", () => {
    const { container } = render(<ContactForm />);

    const honeypot = container.querySelector('input[id="contactWebsite"]');
    expect(honeypot).toHaveAttribute("tabindex", "-1");

    const honeypotWrapper = honeypot?.closest("div");
    expect(honeypotWrapper).toHaveAttribute("aria-hidden", "true");
  });

  it("points the topic hint at /contribute for facility leads and record corrections", () => {
    render(<ContactForm />);
    expect(screen.getByRole("link", { name: "/contribute" })).toHaveAttribute(
      "href",
      "/contribute"
    );
  });

  it("shows a live character counter for the message field", async () => {
    const user = userEvent.setup();
    render(<ContactForm />);

    expect(screen.getByText("0/4000")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^message/i), "hello");
    expect(screen.getByText("5/4000")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Topic select
// ---------------------------------------------------------------------------

describe("ContactForm — topic select", () => {
  it("opens on trigger click, lists every topic option, and updates the trigger on selection", async () => {
    const user = userEvent.setup();
    render(<ContactForm />);

    await user.click(screen.getByRole("combobox", { name: /topic/i }));
    expect(await screen.findByRole("option", { name: "Press inquiry" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Research or academic inquiry" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Partnership" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Correction to the project or site" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Something else" })).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: "Press inquiry" }));
    expect(screen.getByRole("combobox", { name: /topic/i })).toHaveTextContent("Press inquiry");
  });
});

// ---------------------------------------------------------------------------
// Submit outcomes (mocked fetch)
// ---------------------------------------------------------------------------

describe("ContactForm — submit outcomes", () => {
  it("POSTs the trimmed payload (incl. chosen topic) to /api/contact", async () => {
    const user = userEvent.setup();
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });

    render(<ContactForm />);
    await user.type(screen.getByLabelText(/^name/i), "  Jane Reporter  ");
    await user.type(screen.getByLabelText(/^email/i), "  jane@example.com  ");
    await user.click(screen.getByRole("combobox", { name: /topic/i }));
    await user.click(await screen.findByRole("option", { name: "Press inquiry" }));
    await user.type(
      screen.getByLabelText(/^message/i),
      "  I'm writing a story about data center siting and would like to talk.  "
    );
    await user.click(screen.getByRole("button", { name: /send message/i }));

    await screen.findByText(/on its way/i);

    const [url, init] = (global.fetch as unknown as { mock: { calls: [string, RequestInit][] } })
      .mock.calls[0];
    expect(url).toBe("/api/contact");
    expect(init.method).toBe("POST");
    expect(getPostedBody()).toEqual({
      name: "Jane Reporter",
      email: "jane@example.com",
      topic: "press",
      message: "I'm writing a story about data center siting and would like to talk.",
      website: "",
    });
  });

  it("shows the sent confirmation and a reset button on success (201), and moves focus to it", async () => {
    const user = userEvent.setup();
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });

    render(<ContactForm />);
    await fillRequiredTextFields(user);
    await user.click(screen.getByRole("button", { name: /send message/i }));

    const confirmation = await screen.findByText(/on its way/i);
    expect(confirmation).toHaveAttribute("role", "alert");
    expect(confirmation).toHaveFocus();
    expect(screen.getByRole("button", { name: /send another/i })).toBeInTheDocument();
  });

  it("resets to the empty form when 'Send another' is clicked", async () => {
    const user = userEvent.setup();
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });

    render(<ContactForm />);
    await fillRequiredTextFields(user);
    await user.click(screen.getByRole("button", { name: /send message/i }));
    await screen.findByText(/on its way/i);

    await user.click(screen.getByRole("button", { name: /send another/i }));

    expect(screen.getByLabelText(/^name/i)).toHaveValue("");
    expect(screen.getByRole("button", { name: /send message/i })).toBeInTheDocument();
  });

  it("surfaces a field-level error from a 400 response's issues array, next to the right input", async () => {
    const user = userEvent.setup();
    mockFetchOnce({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Invalid message",
        issues: [{ path: ["message"], message: "message must be at least 20 characters" }],
      }),
    });

    render(<ContactForm />);
    await fillRequiredTextFields(user);
    await user.click(screen.getByRole("button", { name: /send message/i }));

    const message = await screen.findByText("message must be at least 20 characters");
    expect(message).toBeInTheDocument();
    expect(message).toHaveAttribute("role", "alert");
    expect(screen.getByLabelText(/^message/i)).toHaveAttribute("aria-invalid", "true");
  });

  it("surfaces the rate-limit message from a 429 response", async () => {
    const user = userEvent.setup();
    mockFetchOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: "Too many messages. Please try again later." }),
    });

    render(<ContactForm />);
    await fillRequiredTextFields(user);
    await user.click(screen.getByRole("button", { name: /send message/i }));

    expect(
      await screen.findByText(/too many messages\. please try again later\./i)
    ).toBeInTheDocument();
  });

  it("surfaces a visible, announced error and does not POST when no topic is selected", async () => {
    const user = userEvent.setup();
    global.fetch = vi.fn();

    render(<ContactForm />);
    // Fills name/email/message directly, deliberately skipping topic
    // selection — fillRequiredTextFields always selects a topic, which
    // would defeat this test's premise.
    await user.type(screen.getByLabelText(/^name/i), "Jane Reporter");
    await user.type(screen.getByLabelText(/^email/i), "jane@example.com");
    await user.type(
      screen.getByLabelText(/^message/i),
      "I'm writing a story about data center siting and would like to talk."
    );
    await user.click(screen.getByRole("button", { name: /send message/i }));

    // Exact match: the Select's own placeholder also reads "Choose a topic"
    // (no trailing period), and a substring/regex match would collide with
    // it — and separately with the role="alert" form-level summary text.
    const error = await screen.findByText("Choose a topic.");
    expect(error).toHaveAttribute("role", "alert");
    expect(screen.getByRole("combobox", { name: /topic/i })).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("disables the submit button while a request is in flight", async () => {
    const user = userEvent.setup();
    let resolveFetch: (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void;
    global.fetch = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    ) as unknown as typeof fetch;

    render(<ContactForm />);
    await fillRequiredTextFields(user);
    await user.click(screen.getByRole("combobox", { name: /topic/i }));
    await user.click(await screen.findByRole("option", { name: "Press inquiry" }));

    const submitButton = screen.getByRole("button", { name: /send message/i });
    await user.click(submitButton);

    expect(submitButton).toBeDisabled();

    resolveFetch!({ ok: true, status: 201, json: async () => ({ ok: true }) });
    await screen.findByText(/on its way/i);
  });
});
