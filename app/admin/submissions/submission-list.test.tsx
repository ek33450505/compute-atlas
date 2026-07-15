import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ReactNode } from "react";
import type { SubmissionRow } from "@/lib/db/schema";

// vi.mock calls are hoisted above imports by Vitest. A plain top-level
// `const mockX = vi.fn()` is NOT reliably safe to reference inside a
// vi.mock factory once the mocked module chain imports multiple mocked
// specifiers — route shared mocks through vi.hoisted() so initialization
// is hoisted alongside the vi.mock calls themselves.
const {
  mockPush,
  mockRefresh,
  mockToastSuccess,
  mockToastError,
  mockApproveSubmissionAction,
  mockRejectSubmissionAction,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
  mockApproveSubmissionAction: vi.fn(),
  mockRejectSubmissionAction: vi.fn(),
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
  approveSubmissionAction: mockApproveSubmissionAction,
  rejectSubmissionAction: mockRejectSubmissionAction,
}));

import { SubmissionList } from "./submission-list";

function makeSubmission(overrides: Partial<SubmissionRow> = {}): SubmissionRow {
  return {
    id: "sub-1",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    status: "pending",
    kind: "create",
    targetFacilityId: null,
    payload: { name: "Test Facility" },
    provenance: {
      sources: ["https://example.com/a", "https://example.com/b"],
      confidence: "reported",
      discoveredBy: "data-wave:run-42",
    },
    reviewNote: null,
    reviewedAt: null,
    ...overrides,
  } as SubmissionRow;
}

// SubmissionDetail is an async server component (fetches live facility data
// via lib/data.ts) and can no longer be imported by this client-component
// test file — submission-list.tsx itself no longer imports it either. Build
// a stand-in per-row detail node instead, matching the shape page.tsx passes
// in production (a Record<string, ReactNode> keyed by submission id).
function renderList(
  submissions: SubmissionRow[],
  activeStatus: "pending" | "approved" | "rejected"
) {
  const details: Record<string, ReactNode> = Object.fromEntries(
    submissions.map((s) => [s.id, <div key={s.id} data-testid="submission-detail">{s.id}</div>])
  );
  return render(
    <SubmissionList submissions={submissions} activeStatus={activeStatus} details={details} />
  );
}

describe("SubmissionList — tabs and empty state", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockRefresh.mockClear();
  });

  it("renders all three status tabs", () => {
    renderList([], "pending");
    expect(screen.getByRole("tab", { name: "Pending" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Approved" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Rejected" })).toBeInTheDocument();
  });

  it("shows an empty-state message when there are no submissions for the active tab", () => {
    renderList([], "pending");
    expect(screen.getByText("No pending submissions.")).toBeInTheDocument();
  });

  it("navigates via router.push when a different tab is selected", async () => {
    const user = userEvent.setup();
    renderList([], "pending");

    await user.click(screen.getByRole("tab", { name: "Approved" }));

    expect(mockPush).toHaveBeenCalledWith("/admin/submissions?status=approved");
  });
});

describe("SubmissionList — row rendering", () => {
  it("renders a create-kind row with kind badge, name, provenance summary", () => {
    const submission = makeSubmission();
    renderList([submission], "pending");

    expect(screen.getByText("New facility")).toBeInTheDocument();
    expect(screen.getByText("Test Facility")).toBeInTheDocument();
    expect(screen.getByText(/data-wave:run-42/)).toBeInTheDocument();
    expect(screen.getByText(/2 sources/)).toBeInTheDocument();
  });

  it("renders an update-kind row with the Update badge and target facility id", () => {
    const submission = makeSubmission({
      kind: "update",
      targetFacilityId: "existing-facility",
      payload: { status: "operational" },
    });
    renderList([submission], "pending");

    expect(screen.getByText("Update")).toBeInTheDocument();
    expect(screen.getByText("(existing-facility)")).toBeInTheDocument();
  });

  it("handles a submission with an unexpected/malformed provenance shape without crashing", () => {
    const submission = makeSubmission({ provenance: {} as unknown as SubmissionRow["provenance"] });
    renderList([submission], "pending");

    // Falls back to "unknown" discoveredBy and 0 sources rather than throwing.
    expect(screen.getByText(/unknown/)).toBeInTheDocument();
    expect(screen.getByText(/0 sources/)).toBeInTheDocument();
  });

  it("does not render Approve/Reject actions for a non-pending (approved) submission", () => {
    const submission = makeSubmission({ status: "approved" });
    renderList([submission], "approved");

    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("toggles the detail view via the expand affordance", async () => {
    const user = userEvent.setup();
    const submission = makeSubmission();
    renderList([submission], "pending");

    expect(screen.queryByTestId("submission-detail")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "View details for Test Facility" }));
    expect(screen.getByTestId("submission-detail")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hide details for Test Facility" }));
    expect(screen.queryByTestId("submission-detail")).not.toBeInTheDocument();
  });
});

describe("SubmissionList — approve action", () => {
  beforeEach(() => {
    mockApproveSubmissionAction.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    mockRefresh.mockClear();
  });

  it("calls approveSubmissionAction and shows a success toast + refreshes on success", async () => {
    mockApproveSubmissionAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderList([makeSubmission()], "pending");

    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(mockApproveSubmissionAction).toHaveBeenCalledWith("sub-1"));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("shows an error toast and does not refresh when approve fails", async () => {
    mockApproveSubmissionAction.mockResolvedValue({
      ok: false,
      status: 409,
      error: "Submission already approved",
    });
    const user = userEvent.setup();
    renderList([makeSubmission()], "pending");

    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Submission already approved")
    );
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe("SubmissionList — reject dialog", () => {
  beforeEach(() => {
    mockRejectSubmissionAction.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    mockRefresh.mockClear();
  });

  it("opens the reject dialog and disables confirm until a non-empty reason is entered", async () => {
    const user = userEvent.setup();
    renderList([makeSubmission()], "pending");

    await user.click(screen.getByRole("button", { name: "Reject" }));

    const confirmButton = screen.getByRole("button", { name: "Confirm reject" });
    expect(confirmButton).toBeDisabled();

    await user.type(screen.getByLabelText("Reason"), "   ");
    expect(confirmButton).toBeDisabled();

    await user.type(screen.getByLabelText("Reason"), "duplicate entry");
    expect(confirmButton).not.toBeDisabled();
  });

  it("calls rejectSubmissionAction with the trimmed reason and shows a success toast on confirm", async () => {
    mockRejectSubmissionAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderList([makeSubmission()], "pending");

    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.type(screen.getByLabelText("Reason"), "  duplicate entry  ");
    await user.click(screen.getByRole("button", { name: "Confirm reject" }));

    await waitFor(() =>
      expect(mockRejectSubmissionAction).toHaveBeenCalledWith("sub-1", "duplicate entry")
    );
    expect(mockToastSuccess).toHaveBeenCalled();
  });
});
