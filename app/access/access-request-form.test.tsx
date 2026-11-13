import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DATASET_CATEGORIES } from "@/lib/db/schema";
import { AccessRequestForm, DATASET_CATEGORY_OPTIONS } from "./access-request-form";

const SUCCESS = /check your inbox: if this address can receive mail from us/i;

function mockFetch(status: number, body: unknown = {}) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

function postedBody(): Record<string, unknown> {
  const calls = (global.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
  return JSON.parse(calls[0][1].body as string);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

type User = ReturnType<typeof userEvent.setup>;

async function fillRequired(user: User) {
  await user.type(screen.getByLabelText(/^email/i), " jane@example.com ");
  await user.type(screen.getByLabelText(/^name/i), "Jane Reporter");
  await user.selectOptions(screen.getByLabelText(/^category/i), "academic");
  await user.type(screen.getByLabelText(/^intended use/i), "A story on siting.");
  await user.click(screen.getByRole("checkbox", { name: /i will credit compute atlas/i }));
  await user.click(screen.getByRole("checkbox", { name: /i accept the access terms \(version 2026-11-draft\)/i }));
}

const submit = (user: User) => user.click(screen.getByRole("button", { name: /request access/i }));

describe("AccessRequestForm commercial category", () => {
  it("shows a note linking to commercial access and disables submit when Commercial is chosen", async () => {
    mockFetch(202, { ok: true });
    const user = userEvent.setup();
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("link", { name: "commercial access" })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/^category/i), "commercial");
    expect(screen.getByRole("link", { name: "commercial access" })).toHaveAttribute("href", "/access/commercial");
    expect(screen.getByRole("status")).toHaveTextContent(/everyone else/i);
    expect(screen.getByRole("status")).toHaveTextContent(/school email/i);
    expect(screen.getByRole("status")).toHaveTextContent(/personal addresses \(Gmail, Outlook and similar\) are declined/i);
    expect(screen.getByRole("button", { name: /request access/i })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText(/^category/i), "academic");
    expect(screen.queryByRole("link", { name: "commercial access" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /request access/i })).toBeEnabled();
  });

  it("renders the note after a 422 from the server", async () => {
    mockFetch(422, { error: "commercial", path: "/access/commercial" });
    const user = userEvent.setup();
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    await fillRequired(user);
    await submit(user);
    expect(await screen.findByRole("link", { name: "commercial access" })).toHaveAttribute("href", "/access/commercial");
    expect(screen.queryByText(SUCCESS)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("AccessRequestForm category options by tier", () => {
  it("offers only the academic option with the tier off", () => {
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier={false} />);
    const options = within(screen.getByLabelText(/^category/i)).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Choose a category", "Student or educator"]);
    expect(screen.queryByRole("option", { name: /something else/i })).not.toBeInTheDocument();
  });

  it("offers the something-else option with the tier on", () => {
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    expect(screen.getByRole("option", { name: /something else/i })).toBeInTheDocument();
  });
});

describe("AccessRequestForm live region layout", () => {
  it("keeps the empty live region out of the flex gap while it has no content", () => {
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier={false} />);
    const region = screen.getByRole("status");
    expect(region).toBeEmptyDOMElement();
    expect(region).toHaveClass("empty:absolute");
  });
});

describe("AccessRequestForm", () => {
  it("offers only values the schema accepts, and only the education and everyone-else choices", () => {
    const values = DATASET_CATEGORY_OPTIONS.map((o) => o.value);
    expect(values).toEqual(["academic", "commercial"]);
    for (const v of values) expect(DATASET_CATEGORIES).toContain(v);
  });

  it("posts the exact JSON, dropping empty links and optional fields", async () => {
    mockFetch(202, { ok: true });
    const user = userEvent.setup();
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    await fillRequired(user);
    await user.type(screen.getByLabelText(/^link 2/i), "  https://example.com/story  ");
    await submit(user);

    const [url, init] = (global.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe("/api/access/request");
    expect(init.method).toBe("POST");
    expect(postedBody()).toEqual({
      email: "jane@example.com",
      name: "Jane Reporter",
      category: "academic",
      intendedUse: "A story on siting.",
      links: ["https://example.com/story"],
      attributionAck: true,
      termsAccepted: true,
      website: "",
    });
  });

  it("includes organization and role when filled", async () => {
    mockFetch(202, { ok: true });
    const user = userEvent.setup();
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    await fillRequired(user);
    await user.type(screen.getByLabelText(/^organization/i), "The Paper");
    await user.type(screen.getByLabelText(/^role/i), "Reporter");
    await submit(user);
    expect(postedBody()).toMatchObject({ organization: "The Paper", role: "Reporter" });
  });

  it("shows one identical success message whatever the 202 body says", async () => {
    const texts: string[] = [];
    for (const body of [{ ok: true }, { ok: false, status: "approved" }, {}]) {
      mockFetch(202, body);
      const user = userEvent.setup();
      const { unmount } = render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
      await fillRequired(user);
      await submit(user);
      const status = await screen.findByRole("status");
      expect(status).toHaveTextContent(SUCCESS);
      expect(status).toHaveFocus();
      expect(screen.queryByRole("button", { name: /request access/i })).not.toBeInTheDocument();
      texts.push(status.textContent ?? "");
      unmount();
    }
    expect(new Set(texts).size).toBe(1);
  });

  it("maps a 400 to field errors and focuses the error summary", async () => {
    mockFetch(400, {
      error: "Invalid request",
      issues: [{ path: ["email"], message: "Enter a valid email address." }],
    });
    const user = userEvent.setup();
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    await fillRequired(user);
    await submit(user);

    const summary = await screen.findByRole("alert", { name: /fix the errors/i });
    expect(summary).toHaveFocus();
    expect(screen.getAllByText("Enter a valid email address.").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /enter a valid email address/i })).toHaveAttribute(
      "href",
      "#access-email",
    );
    expect(screen.getByLabelText(/^email/i)).toHaveAttribute("aria-invalid", "true");
  });

  it.each([
    [413, /that is too long to send/i],
    [429, /too many requests from this network\. try again in an hour/i],
    [503, /requests are temporarily unavailable\. try again later/i],
    [403, /requests are temporarily unavailable\. try again later/i],
  ])("shows the message for a %i", async (status, message) => {
    mockFetch(status, { error: "x" });
    const user = userEvent.setup();
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    await fillRequired(user);
    await submit(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("shows the unavailable message on a network error", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    await fillRequired(user);
    await submit(user);
    expect(await screen.findByRole("alert")).toHaveTextContent(/temporarily unavailable/i);
  });

  it("blocks submit without fetching when the checkboxes are unchecked", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    await user.type(screen.getByLabelText(/^email/i), "jane@example.com");
    await user.type(screen.getByLabelText(/^name/i), "Jane");
    await user.selectOptions(screen.getByLabelText(/^category/i), "academic");
    await user.type(screen.getByLabelText(/^intended use/i), "Research.");
    await submit(user);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.getByRole("alert", { name: /fix the errors/i })).toHaveFocus();
    expect(screen.getByRole("checkbox", { name: /i will credit/i })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("checkbox", { name: /i accept the access terms/i })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("blocks submit when required text fields and category are empty", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    await submit(user);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/^email/i)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/^category/i)).toHaveAttribute("aria-invalid", "true");
  });

  it("hides the honeypot from assistive tech and the tab order", () => {
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    const input = document.querySelector<HTMLInputElement>('input[name="accessWebsite"]');
    expect(input).not.toBeNull();
    expect(input).toHaveAttribute("tabindex", "-1");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input!.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it("updates the intended-use counter as the user types", async () => {
    const user = userEvent.setup();
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    expect(screen.getByText("0 of 2000")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^intended use/i), "abcd");
    expect(screen.getByText("4 of 2000")).toBeInTheDocument();
  });

  it("shows a generic message when a 400 only names fields without a control", async () => {
    mockFetch(400, { error: "Invalid", issues: [{ path: ["website"], message: "Bad" }] });
    const user = userEvent.setup();
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    await fillRequired(user);
    await submit(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("Please check the form and try again.");
  });

  it("shows the generic message when a 400 body is not JSON", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    await fillRequired(user);
    await submit(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("Please check the form and try again.");
  });

  it("maps a links.0 issue to the first link field", async () => {
    mockFetch(400, { error: "Invalid", issues: [{ path: ["links", 0], message: "Enter a valid URL." }] });
    const user = userEvent.setup();
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    await fillRequired(user);
    await submit(user);
    await screen.findByRole("alert");
    expect(screen.getByLabelText(/^link 1/i)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/^link 1/i)).toHaveAccessibleDescription(/enter a valid url/i);
  });

  it("submits when Enter is pressed in a text field of a valid form", async () => {
    mockFetch(202, { ok: true });
    const user = userEvent.setup();
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    await fillRequired(user);
    await user.type(screen.getByLabelText(/^organization/i), "The Paper{enter}");
    expect(await screen.findByRole("status")).toHaveTextContent(SUCCESS);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("makes exactly one request when submitted twice before the first resolves", async () => {
    let resolve!: (v: unknown) => void;
    global.fetch = vi.fn().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    ) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    await fillRequired(user);
    const form = screen.getByRole("button", { name: /request access/i }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    resolve({ ok: true, status: 202, json: async () => ({ ok: true }) });
    await screen.findByRole("status");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps focus on the submit button and labels it Sending while submitting", async () => {
    let resolve!: (v: unknown) => void;
    global.fetch = vi.fn().mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    ) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    await fillRequired(user);
    const button = screen.getByRole("button", { name: /request access/i });
    await user.click(button);
    await waitFor(() => expect(button).toHaveTextContent("Sending…"));
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAttribute("aria-busy");
    expect(document.activeElement).toBe(button);
    resolve({ ok: true, status: 202, json: async () => ({}) });
    await screen.findByRole("status");
  });

  it("has exactly one role=alert after a failed submit with several field errors", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<AccessRequestForm termsVersion="2026-11-draft" commercialTier />);
    await submit(user);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByLabelText(/^email/i)).toHaveAccessibleDescription(/enter your email address/i);
  });
});
