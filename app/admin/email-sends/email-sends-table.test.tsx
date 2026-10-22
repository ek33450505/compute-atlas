import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("@/app/admin/email-sends/actions", () => ({ lookupEmailSendsAction: vi.fn() }));

import { AddressLookupForm } from "./address-lookup-form";
import { EmailSendsTable, type EmailSendsTableRow } from "./email-sends-table";

const row: EmailSendsTableRow = {
  id: "r1",
  createdAt: new Date("2026-10-01T12:00:00Z"),
  completedAt: null,
  kind: "state_digest",
  outcome: "error",
  targetType: "state",
  targetId: "TX",
  runId: "11111111-1111-4111-8111-111111111111",
  resendId: null,
  errorCode: "rate_limited",
  subscriptionId: null,
  hashPrefix: "abcd1234",
};

describe("EmailSendsTable", () => {
  it("renders a captioned table with headers and the row values", () => {
    render(<EmailSendsTable rows={[row]} caption="Email sends" />);
    const table = screen.getByRole("table", { name: "Email sends" });
    expect(within(table).getByRole("columnheader", { name: "Outcome" })).toBeInTheDocument();
    expect(within(table).getByText("state_digest")).toBeInTheDocument();
    expect(within(table).getByText("error")).toBeInTheDocument();
    expect(within(table).getByText("state: TX")).toBeInTheDocument();
    expect(within(table).getByText("rate_limited")).toBeInTheDocument();
    expect(within(table).getByText("abcd1234")).toBeInTheDocument();
    expect(within(table).getByText("2026-10-01 12:00:00Z")).toBeInTheDocument();
  });

  it("wraps the table in a focusable, labelled scroll region", () => {
    render(<EmailSendsTable rows={[row]} caption="Email sends" />);
    const region = screen.getByRole("region", { name: "Email sends table, scrolls horizontally" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(within(region).getByRole("table")).toBeInTheDocument();
  });

  it("says so when there are no rows", () => {
    render(<EmailSendsTable rows={[]} caption="Email sends" />);
    expect(screen.getByText("No sends match.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("AddressLookupForm", () => {
  it("renders the status region before any submit so results are announced", () => {
    render(<AddressLookupForm />);
    const status = screen.getByRole("status");
    expect(status).toBeInTheDocument();
    expect(status).toBeEmptyDOMElement();
  });

  it("has a labelled address field and a submit button", () => {
    render(<AddressLookupForm />);
    expect(screen.getByLabelText("Email address")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Look up" })).toBeInTheDocument();
  });
});
