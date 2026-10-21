import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ContactForm, applyPrefill } from "./contact-form";

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

// ---------------------------------------------------------------------------
// URL prefill — the correction dialog links here as
// /contact?topic=correction&about=<facility name> for people with no source.
// ---------------------------------------------------------------------------

describe("ContactForm — URL prefill", () => {
  function renderAt(search: string) {
    window.history.pushState({}, "", `/contact${search}`);
    render(<ContactForm />);
  }

  afterEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("selects the topic and seeds the message from ?topic and ?about", () => {
    renderAt("?topic=correction&about=Test%20DC");

    expect(screen.getByRole("combobox", { name: /topic/i })).toHaveTextContent(
      "Correction to the project or site"
    );
    expect(screen.getByLabelText(/^message/i)).toHaveValue("About Test DC: ");
  });

  it("ignores a topic that is not one of the form's topics", () => {
    renderAt("?topic=evil&about=Test%20DC");

    expect(screen.getByRole("combobox", { name: /topic/i })).toHaveTextContent("Choose a topic");
    // A bad topic does not discard the valid ?about.
    expect(screen.getByLabelText(/^message/i)).toHaveValue("About Test DC: ");
  });

  it("caps ?about at 200 characters", () => {
    renderAt(`?topic=correction&about=${"a".repeat(250)}`);

    expect(screen.getByLabelText(/^message/i)).toHaveValue(`About ${"a".repeat(200)}: `);
  });

  it("applies a topic alone without touching the message", () => {
    renderAt("?topic=press");

    expect(screen.getByRole("combobox", { name: /topic/i })).toHaveTextContent("Press inquiry");
    expect(screen.getByLabelText(/^message/i)).toHaveValue("");
  });

  it("seeds the message alone without choosing a topic", () => {
    renderAt("?about=Test%20DC");

    expect(screen.getByRole("combobox", { name: /topic/i })).toHaveTextContent("Choose a topic");
    expect(screen.getByLabelText(/^message/i)).toHaveValue("About Test DC: ");
  });

  it("ignores a blank ?about", () => {
    renderAt("?topic=correction&about=%20%20");

    expect(screen.getByLabelText(/^message/i)).toHaveValue("");
  });

  it("leaves a plain /contact exactly as before", () => {
    renderAt("");

    expect(screen.getByRole("combobox", { name: /topic/i })).toHaveTextContent("Choose a topic");
    expect(screen.getByLabelText(/^message/i)).toHaveValue("");
    expect(screen.getByText("0/4000")).toBeInTheDocument();
  });

  it("submits the prefilled topic and message once the rest is filled in", async () => {
    mockFetchOnce({ ok: true, status: 201, json: async () => ({ ok: true }) });
    const user = userEvent.setup();
    renderAt("?topic=correction&about=Test%20DC");

    await user.type(screen.getByLabelText(/^name/i), "Jane Reporter");
    await user.type(screen.getByLabelText(/^email/i), "jane@example.com");
    await user.type(screen.getByLabelText(/^message/i), "the capacity figure looks wrong");
    await user.click(screen.getByRole("button", { name: /send message/i }));

    await screen.findByText(/your message is on its way/i);
    const body = getPostedBody();
    expect(body.topic).toBe("correction");
    expect(body.message).toBe("About Test DC: the capacity figure looks wrong");
  });
});

// The pure helper behind the mount effect. The effect normally sees an empty
// form, but its empty-only guards also protect anything typed between hydration
// and the effect running, a window a mount-time test can't drive. So "never
// overwrite what the user typed" is pinned here, on the helper.
describe("applyPrefill", () => {
  const EMPTY: Parameters<typeof applyPrefill>[0] = {
    name: "",
    email: "",
    topic: "",
    message: "",
    website: "",
  };

  it("never overwrites a message the user already typed", () => {
    const typed = { ...EMPTY, message: "my own words" };
    expect(applyPrefill(typed, "?about=Test%20DC").message).toBe("my own words");
  });

  it("never overwrites a topic the user already chose", () => {
    const chosen = { ...EMPTY, topic: "press" as const };
    expect(applyPrefill(chosen, "?topic=correction").topic).toBe("press");
  });

  it.each(["", "?topic=evil", "?about=%20%20", "?foo=bar", "?topic=", "?about="])(
    "hands back the very same state when %j carries nothing valid, so React skips the render",
    (search) => {
      expect(applyPrefill(EMPTY, search)).toBe(EMPTY);
    }
  );

  it("decodes '+' as a space and trims the facility name", () => {
    expect(applyPrefill(EMPTY, "?about=++Test+DC++").message).toBe("About Test DC: ");
  });

  it("does not leave a dangling space when the 200-character cut lands on one", () => {
    const about = `${"a".repeat(199)} b`;
    expect(applyPrefill(EMPTY, `?about=${encodeURIComponent(about)}`).message).toBe(
      `About ${"a".repeat(199)}: `
    );
  });

  it("cuts at 200 code points, not UTF-16 units, so an emoji on the boundary stays whole", () => {
    const about = `${"a".repeat(199)}\u{1F600}b`;
    expect(applyPrefill(EMPTY, `?about=${encodeURIComponent(about)}`).message).toBe(
      `About ${"a".repeat(199)}\u{1F600}: `
    );
  });

  it.each(["press", "research", "partnership", "correction", "other"] as const)(
    "accepts the %s topic",
    (topic) => {
      expect(applyPrefill(EMPTY, `?topic=${topic}`).topic).toBe(topic);
    }
  );
});
