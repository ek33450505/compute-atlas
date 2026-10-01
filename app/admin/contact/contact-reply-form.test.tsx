import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockAction, mockToast } = vi.hoisted(() => ({
  mockAction: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/admin/contact/actions", () => ({
  replyToContactMessageAction: mockAction,
}));
vi.mock("sonner", () => ({ toast: mockToast }));

import { ContactReplyForm } from "./contact-reply-form";

describe("ContactReplyForm", () => {
  beforeEach(() => {
    mockAction.mockReset();
    mockToast.success.mockReset();
    mockToast.error.mockReset();
  });

  it("toggle reveals a labelled textbox; Send is disabled while empty", async () => {
    const user = userEvent.setup();
    render(<ContactReplyForm messageId="m1" recipientName="Jamie" />);

    const toggle = screen.getByRole("button", { name: "Reply as Compute Atlas" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const box = screen.getByRole("textbox", { name: "Reply to Jamie" });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    await user.type(box, "   ");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await user.type(box, "Thanks");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("sends only the id and body, then collapses with a persistent status", async () => {
    const user = userEvent.setup();
    mockAction.mockResolvedValue({ ok: true });
    render(<ContactReplyForm messageId="m1" recipientName="Jamie" />);

    await user.click(screen.getByRole("button", { name: "Reply as Compute Atlas" }));
    await user.type(screen.getByRole("textbox"), "Hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Reply sent"));
    expect(mockAction).toHaveBeenCalledWith("m1", "Hello");
    expect(mockToast.success).toHaveBeenCalledWith("Reply sent");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reply as Compute Atlas/ })).toHaveFocus();
  });

  it("returns focus to the toggle after a second successful reply", async () => {
    const user = userEvent.setup();
    mockAction.mockResolvedValue({ ok: true });
    render(<ContactReplyForm messageId="m1" recipientName="Jamie" />);
    const toggle = () => screen.getByRole("button", { name: /Reply as Compute Atlas/ });

    await user.click(toggle());
    await user.type(screen.getByRole("textbox"), "First");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(toggle()).toHaveFocus());

    await user.click(toggle());
    await user.type(screen.getByRole("textbox"), "Second");
    // Focus is on the textarea, then moves to Send on click: never the toggle,
    // so the final assertion proves the effect re-ran rather than a stale focus.
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(toggle()).not.toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(mockAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
    expect(toggle()).toHaveFocus();
  });

  it("keeps the text and toasts the error on failure", async () => {
    const user = userEvent.setup();
    mockAction.mockResolvedValue({ ok: false, error: "Message not found" });
    render(<ContactReplyForm messageId="m1" recipientName="Jamie" />);

    await user.click(screen.getByRole("button", { name: "Reply as Compute Atlas" }));
    await user.type(screen.getByRole("textbox"), "Hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("Message not found"));
    expect(screen.getByRole("textbox")).toHaveValue("Hello");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
