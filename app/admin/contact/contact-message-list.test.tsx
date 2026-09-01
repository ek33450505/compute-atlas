import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import type { AdminContactRow } from "@/lib/contact";
import { ContactMessageList } from "./contact-message-list";

function makeMessage(overrides: Partial<AdminContactRow> = {}): AdminContactRow {
  return {
    id: "msg-1",
    createdAt: new Date("2026-08-31T12:00:00Z"),
    name: "Jamie Rivera",
    email: "jamie@example.com",
    topic: "press",
    message: "This is a message with well over twenty characters in it.",
    emailSent: true,
    ...overrides,
  };
}

describe("ContactMessageList — empty state", () => {
  it("shows an empty-state message when there are no messages", () => {
    render(<ContactMessageList messages={[]} />);
    expect(screen.getByText("No contact messages yet.")).toBeInTheDocument();
  });
});

describe("ContactMessageList — row rendering", () => {
  it("renders name, topic, message body, and a mailto link for the email", () => {
    render(<ContactMessageList messages={[makeMessage()]} />);

    expect(screen.getByText("Jamie Rivera")).toBeInTheDocument();
    expect(screen.getByText("press")).toBeInTheDocument();
    expect(
      screen.getByText("This is a message with well over twenty characters in it.")
    ).toBeInTheDocument();

    const emailLink = screen.getByRole("link", { name: "jamie@example.com" });
    expect(emailLink).toHaveAttribute("href", "mailto:jamie@example.com");
  });

  it("shows a quiet confirmation when the notification email sent", () => {
    render(<ContactMessageList messages={[makeMessage({ emailSent: true })]} />);

    expect(screen.getByText("Notification email sent")).toBeInTheDocument();
    expect(screen.queryByText("Notification email not sent")).not.toBeInTheDocument();
  });

  it("prominently flags a message whose notification email did not send", () => {
    render(<ContactMessageList messages={[makeMessage({ emailSent: false })]} />);

    const failure = screen.getByText("Notification email not sent");
    expect(failure).toBeInTheDocument();
    // Failure state must not rely on colour alone — it carries its own text,
    // distinct from the quiet "sent" confirmation.
    expect(screen.queryByText("Notification email sent")).not.toBeInTheDocument();
  });

  it("renders multiple messages", () => {
    render(
      <ContactMessageList
        messages={[
          makeMessage({ id: "msg-1", name: "Jamie Rivera" }),
          makeMessage({ id: "msg-2", name: "Alex Chen", topic: "research" }),
        ]}
      />
    );

    expect(screen.getByText("Jamie Rivera")).toBeInTheDocument();
    expect(screen.getByText("Alex Chen")).toBeInTheDocument();
  });
});
