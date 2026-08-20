import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AdminLeadRow } from "@/lib/leads";

// vi.mock calls are hoisted above imports by Vitest. A plain top-level
// `const mockX = vi.fn()` is NOT reliably safe to reference inside a
// vi.mock factory once the mocked module chain imports multiple mocked
// specifiers — route shared mocks through vi.hoisted() so initialization
// is hoisted alongside the vi.mock calls themselves, matching
// app/admin/submissions/submission-list.test.tsx.
const {
  mockPush,
  mockRefresh,
  mockToastSuccess,
  mockToastError,
  mockMarkResearching,
  mockMarkPromoted,
  mockDismiss,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockMarkResearching: vi.fn(),
  mockMarkPromoted: vi.fn(),
  mockDismiss: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

vi.mock("./actions", () => ({
  markLeadResearchingAction: mockMarkResearching,
  markLeadPromotedAction: mockMarkPromoted,
  dismissLeadAction: mockDismiss,
}));

import { LeadList } from "./lead-list";

function makeLead(overrides: Partial<AdminLeadRow> = {}): AdminLeadRow {
  return {
    id: "lead-1",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    url: "https://example.com/tip",
    note: "Saw excavators on the site",
    attribution: "A Local",
    status: "new",
    triage: null,
    reviewNote: null,
    reviewedAt: null,
    promotedSubmissionId: null,
    ...overrides,
  };
}

function renderList(leads: AdminLeadRow[], activeStatus: "new" | "researching" | "promoted" | "dismissed") {
  return render(<LeadList leads={leads} activeStatus={activeStatus} />);
}

describe("LeadList — tabs and empty state", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockRefresh.mockClear();
  });

  it("renders all four status tabs", () => {
    renderList([], "new");
    expect(screen.getByRole("tab", { name: "New" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Researching" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Promoted" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Dismissed" })).toBeInTheDocument();
  });

  it("shows an empty-state message when there are no leads for the active tab", () => {
    renderList([], "new");
    expect(screen.getByText("No new leads.")).toBeInTheDocument();
  });

  it("navigates via router.push when a different tab is selected", async () => {
    const user = userEvent.setup();
    renderList([], "new");

    await user.click(screen.getByRole("tab", { name: "Researching" }));

    expect(mockPush).toHaveBeenCalledWith("/admin/leads?status=researching");
  });
});

describe("LeadList — row rendering", () => {
  it("renders the URL as a link, note, attribution, and createdAt", () => {
    renderList([makeLead()], "new");

    const link = screen.getByRole("link", { name: /https:\/\/example\.com\/tip \(opens in new tab\)/ });
    expect(link).toHaveAttribute("href", "https://example.com/tip");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
    expect(screen.getByText("Saw excavators on the site")).toBeInTheDocument();
    expect(screen.getByText(/A Local/)).toBeInTheDocument();
  });

  it('falls back to "anonymous" when attribution is missing', () => {
    renderList([makeLead({ attribution: null })], "new");
    expect(screen.getByText(/anonymous/)).toBeInTheDocument();
  });

  it('renders "Not checked yet" for a null triage, without any error styling', () => {
    renderList([makeLead({ triage: null })], "new");

    const status = screen.getByText("Not checked yet");
    expect(status).toBeInTheDocument();
    // A null triage means the fetch hadn't completed — must never render
    // with the same destructive-text class used for an actual unreachable
    // result below.
    expect(status.closest("p")).not.toHaveClass("text-destructive");
  });

  it("renders an unreachable triage result with its error and http status", () => {
    renderList(
      [
        makeLead({
          triage: {
            fetchedAt: "2026-08-19T00:00:00Z",
            ok: false,
            httpStatus: 404,
            error: "Not Found",
          },
        }),
      ],
      "new"
    );

    expect(screen.getByText(/Source unreachable/)).toBeInTheDocument();
    expect(screen.getByText(/HTTP 404/)).toBeInTheDocument();
    expect(screen.getByText("Not Found")).toBeInTheDocument();
  });

  it("renders a reachable triage result with title, and flags a redirect to a different finalUrl", () => {
    renderList(
      [
        makeLead({
          url: "https://example.com/tip",
          triage: {
            fetchedAt: "2026-08-19T00:00:00Z",
            ok: true,
            httpStatus: 200,
            title: "New Data Center Announced",
            finalUrl: "https://example.com/tip/redirected",
          },
        }),
      ],
      "new"
    );

    expect(screen.getByText(/Reachable/)).toBeInTheDocument();
    expect(screen.getByText(/New Data Center Announced/)).toBeInTheDocument();
    expect(screen.getByText(/Redirected to/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /https:\/\/example\.com\/tip\/redirected \(opens in new tab\)/ })
    ).toBeInTheDocument();
  });

  it("does not flag a redirect when finalUrl matches the submitted url", () => {
    renderList(
      [
        makeLead({
          url: "https://example.com/tip",
          triage: {
            fetchedAt: "2026-08-19T00:00:00Z",
            ok: true,
            httpStatus: 200,
            finalUrl: "https://example.com/tip",
          },
        }),
      ],
      "new"
    );

    expect(screen.queryByText(/Redirected to/)).not.toBeInTheDocument();
  });

  it("surfaces duplicateFacilityIds prominently as links to /facilities/<id>", () => {
    renderList(
      [
        makeLead({
          triage: {
            fetchedAt: "2026-08-19T00:00:00Z",
            ok: true,
            duplicateFacilityIds: ["existing-site-1"],
          },
        }),
      ],
      "new"
    );

    expect(screen.getByText(/Possible duplicate/)).toBeInTheDocument();
    const dupLink = screen.getByRole("link", {
      name: /View existing facility existing-site-1 \(opens in new tab\)/,
    });
    expect(dupLink).toHaveAttribute("href", "/facilities/existing-site-1");
  });

  it("escapes attacker-controlled triage.title as plain text and never creates a live element from it", () => {
    // Guards the security requirement: triage fields are scraped from an
    // arbitrary public page and must render only as escaped JSX text.
    const payload = "<img src=x onerror=alert(1)>";
    renderList(
      [
        makeLead({
          triage: {
            fetchedAt: "2026-08-19T00:00:00Z",
            ok: true,
            httpStatus: 200,
            title: payload,
          },
        }),
      ],
      "new"
    );

    // The text is visible verbatim...
    expect(screen.getByText(new RegExp(payload.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
    // ...but never parsed into a live <img> element.
    expect(document.querySelector("img")).not.toBeInTheDocument();
  });

  it("does not show status actions for a terminal (promoted) lead", () => {
    renderList([makeLead({ status: "promoted" })], "promoted");

    expect(screen.queryByRole("button", { name: "Start researching" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark promoted" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });

  it("shows only Mark promoted / Dismiss (not Start researching) for a researching lead", () => {
    renderList([makeLead({ status: "researching" })], "researching");

    expect(screen.queryByRole("button", { name: "Start researching" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark promoted" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });
});

describe("LeadList — status actions", () => {
  beforeEach(() => {
    mockMarkResearching.mockClear();
    mockMarkPromoted.mockClear();
    mockDismiss.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    mockRefresh.mockClear();
  });

  it("calls markLeadResearchingAction and refreshes on success", async () => {
    mockMarkResearching.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderList([makeLead()], "new");

    await user.click(screen.getByRole("button", { name: "Start researching" }));

    await waitFor(() => expect(mockMarkResearching).toHaveBeenCalledWith("lead-1"));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("calls markLeadPromotedAction and refreshes on success", async () => {
    mockMarkPromoted.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderList([makeLead()], "new");

    await user.click(screen.getByRole("button", { name: "Mark promoted" }));

    await waitFor(() => expect(mockMarkPromoted).toHaveBeenCalledWith("lead-1"));
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("shows an error toast and does not refresh when an action fails", async () => {
    mockMarkPromoted.mockResolvedValue({ ok: false, status: 409, error: "Lead already promoted" });
    const user = userEvent.setup();
    renderList([makeLead()], "new");

    await user.click(screen.getByRole("button", { name: "Mark promoted" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Lead already promoted"));
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("disables the dismiss confirm button until a non-empty reason is entered", async () => {
    const user = userEvent.setup();
    renderList([makeLead()], "new");

    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    const confirmButton = screen.getByRole("button", { name: "Confirm dismiss" });
    expect(confirmButton).toBeDisabled();

    await user.type(screen.getByLabelText("Reason"), "   ");
    expect(confirmButton).toBeDisabled();

    await user.type(screen.getByLabelText("Reason"), "not relevant");
    expect(confirmButton).not.toBeDisabled();
  });

  it("calls dismissLeadAction with the trimmed reason on confirm", async () => {
    mockDismiss.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderList([makeLead()], "new");

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await user.type(screen.getByLabelText("Reason"), "  not relevant  ");
    await user.click(screen.getByRole("button", { name: "Confirm dismiss" }));

    await waitFor(() => expect(mockDismiss).toHaveBeenCalledWith("lead-1", "not relevant"));
    expect(mockToastSuccess).toHaveBeenCalled();
  });
});
