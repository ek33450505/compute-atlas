import { vi, describe, it, expect, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { QueueGrant } from "./grant-views";

const { mockRefresh, mockApprove, mockReject } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockApprove: vi.fn(),
  mockReject: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/app/admin/access/actions", () => ({
  approveDatasetGrantAction: mockApprove,
  rejectDatasetGrantAction: mockReject,
}));

import { AccessQueue } from "./access-queue";
import { LOCK_RELEASE_MS } from "./shared";

function makeGrant(overrides: Partial<QueueGrant> = {}): QueueGrant {
  return {
    id: "g1",
    createdAt: new Date("2026-11-01T10:00:00Z"),
    email: "ada@example.org",
    name: "Ada Lovelace",
    organization: "Analytical Engines",
    role: "Reporter",
    category: "journalist",
    intendedUse: "Mapping water use.\nSecond line.",
    links: ["https://example.org/profile"],
    status: "pending_review",
    expiresAt: null,
    renewalRequestedAt: null,
    live: false,
    renewalPending: false,
    ...overrides,
  };
}

function makeRenewal(overrides: Partial<QueueGrant> = {}): QueueGrant {
  return makeGrant({
    id: "r1",
    name: "Grace Hopper",
    email: "grace@example.org",
    status: "active",
    expiresAt: new Date("2026-10-01T00:00:00Z"),
    renewalRequestedAt: new Date("2026-10-20T00:00:00Z"),
    live: false,
    renewalPending: true,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AccessQueue: listing", () => {
  it("shows the heading, a count and an empty state", () => {
    render(<AccessQueue grants={[]} />);
    expect(screen.getByRole("heading", { level: 2, name: /Review queue/ })).toBeInTheDocument();
    expect(screen.getByText("Nothing is waiting for review.")).toBeInTheDocument();
  });

  it("renders every grant the page passes, new requests and renewals alike, with a count", () => {
    render(
      <AccessQueue
        grants={[
          makeGrant({ id: "a", name: "New Person" }),
          makeRenewal({ id: "b", name: "Renewing Person" }),
        ]}
      />
    );
    expect(screen.getByRole("heading", { level: 2, name: /Review queue/ })).toHaveTextContent("(2)");
    expect(screen.getByRole("article", { name: /New Person/ })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: /Renewing Person/ })).toBeInTheDocument();
  });

  it("labels the email as verified and everything else as unauthenticated", () => {
    render(<AccessQueue grants={[makeGrant()]} />);
    const row = screen.getByRole("article", { name: /Ada Lovelace/ });
    expect(within(row).getByText("Email (verified)")).toBeInTheDocument();
    expect(within(row).getByText("ada@example.org")).toBeInTheDocument();
    const submitted = within(row).getByRole("region", { name: /Unauthenticated: as submitted, not verified/ });
    expect(within(submitted).getByText(/Only the email address was verified\./)).toBeInTheDocument();
    expect(within(submitted).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(submitted).getByText("Analytical Engines")).toBeInTheDocument();
    expect(within(submitted).getByText("Reporter")).toBeInTheDocument();
    expect(within(submitted).getByText("journalist")).toBeInTheDocument();
    expect(within(submitted).getByText("https://example.org/profile")).toBeInTheDocument();
    // The verified email is outside the unverified group.
    expect(within(submitted).queryByText("ada@example.org")).not.toBeInTheDocument();
  });

  it("renders requester text and links as inert text, never markup or anchors", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const { container } = render(
      <AccessQueue
        grants={[
          makeGrant({
            name: hostile,
            organization: hostile,
            role: hostile,
            intendedUse: hostile,
            links: [hostile, "javascript:alert(1)"],
          }),
        ]}
      />
    );
    expect(screen.getAllByText(hostile).length).toBeGreaterThan(0);
    expect(screen.getByText("javascript:alert(1)")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector('[href^="javascript:"]')).toBeNull();
  });

  it("shows a renewal past expiry as paused and offers Approve renewal", () => {
    render(<AccessQueue grants={[makeRenewal()]} />);
    const row = screen.getByRole("article", { name: /Grace Hopper/ });
    expect(within(row).getByText(/Renewal requested/)).toBeInTheDocument();
    expect(
      within(row).getByText(/Expired .*: downloads are paused until you approve/)
    ).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /Approve renewal for Grace Hopper/ })).not.toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(within(row).queryByRole("button", { name: /Reject/ })).not.toBeInTheDocument();
  });

  it("does not claim a live renewal is paused", () => {
    render(
      <AccessQueue
        grants={[makeRenewal({ live: true, expiresAt: new Date("2027-01-01T00:00:00Z") })]}
      />
    );
    expect(screen.getByText(/Renewal requested/)).toBeInTheDocument();
    expect(screen.queryByText(/downloads are paused/)).not.toBeInTheDocument();
  });

  it("gives every control a visible label and names buttons by requester", () => {
    render(<AccessQueue grants={[makeGrant()]} />);
    expect(screen.getByLabelText(/Internal note/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Note sent to the requester/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve request from Ada Lovelace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject request from Ada Lovelace" })).toBeInTheDocument();
  });
});

describe("AccessQueue: approve", () => {
  it("passes the internal note, reports a delivered email by name, and refreshes", async () => {
    mockApprove.mockResolvedValue({ ok: true, kind: "approved", mail: "sent" });
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);

    await user.type(screen.getByLabelText(/Internal note/), "Checked the byline");
    await user.click(screen.getByRole("button", { name: /Approve request from Ada Lovelace/ }));

    await waitFor(() => expect(mockApprove).toHaveBeenCalledWith("g1", "Checked the byline"));
    const status = await screen.findByRole("status");
    await waitFor(() => expect(status).toHaveTextContent(/Ada Lovelace/));
    expect(status).toHaveTextContent("approval email was sent");
    expect(status).not.toHaveTextContent("NOT");
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("sends no note when the field is empty", async () => {
    mockApprove.mockResolvedValue({ ok: true, kind: "approved", mail: "sent" });
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);
    await user.click(screen.getByRole("button", { name: /Approve request from/ }));
    await waitFor(() => expect(mockApprove).toHaveBeenCalledWith("g1", undefined));
  });

  it("says plainly when the requester did NOT get their link", async () => {
    mockApprove.mockResolvedValue({ ok: true, kind: "approved", mail: "skipped_suppressed" });
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);
    await user.click(screen.getByRole("button", { name: /Approve request from/ }));

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveTextContent("does NOT have their link"));
    expect(alert).toHaveTextContent("Ada Lovelace");
    expect(alert).toHaveTextContent("skipped_suppressed");
    // Not color alone: the undelivered case carries a text marker.
    expect(within(alert).getByText(/Not delivered/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("keeps the outcome after the row leaves the queue", async () => {
    mockApprove.mockResolvedValue({ ok: true, kind: "approved", mail: "skipped_no_key" });
    const user = userEvent.setup();
    const { rerender } = render(<AccessQueue grants={[makeGrant()]} />);
    await user.click(screen.getByRole("button", { name: /Approve request from/ }));
    await screen.findByText(/skipped_no_key/);

    rerender(<AccessQueue grants={[]} />);
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("skipped_no_key");
  });

  it("reports an approved renewal as sending no email", async () => {
    mockApprove.mockResolvedValue({ ok: true, kind: "renewed" });
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeRenewal()]} />);
    await user.click(screen.getByRole("button", { name: /Approve renewal for Grace Hopper/ }));

    const status = await screen.findByRole("status");
    await waitFor(() => expect(status).toHaveTextContent("Renewal approved"));
    expect(status).toHaveTextContent("Grace Hopper");
    expect(status).toHaveTextContent("No email is sent.");
    expect(mockApprove).toHaveBeenCalledWith("r1", undefined);
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("marks the row's buttons aria-disabled while the action is pending, and frees them on a failure", async () => {
    let resolve!: (value: unknown) => void;
    mockApprove.mockReturnValue(new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);

    await user.click(screen.getByRole("button", { name: /Approve request from/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Approve request from/ })).toHaveAttribute(
        "aria-disabled",
        "true"
      )
    );
    expect(screen.getByRole("button", { name: /Reject request from/ })).toHaveAttribute(
      "aria-disabled",
      "true"
    );

    // A failed result frees the buttons again (a success keeps them locked: see below).
    resolve({ ok: false, error: "Nope." });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Approve request from/ })).not.toHaveAttribute(
        "aria-disabled",
        "true"
      )
    );
  });

  it("keeps keyboard focus on the pressed button while pending and ignores a second activation", async () => {
    let resolve!: (value: unknown) => void;
    mockApprove.mockReturnValue(new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);

    const approve = screen.getByRole("button", { name: /Approve request from/ });
    approve.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(approve).toHaveAttribute("aria-disabled", "true"));
    // Not natively disabled: a disabled element cannot hold focus, and focus would drop to <body>.
    expect(approve).not.toBeDisabled();
    expect(approve).toHaveFocus();

    await user.keyboard("{Enter}");
    await user.click(approve);
    expect(mockApprove).toHaveBeenCalledTimes(1);
    resolve({ ok: false, error: "Nope." });
  });

  it("marks the row busy and shows Working… only while its request is in flight", async () => {
    let resolve!: (value: unknown) => void;
    mockApprove.mockReturnValue(new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);
    const row = screen.getByRole("article", { name: /Ada Lovelace/ });
    expect(row).not.toHaveAttribute("aria-busy", "true");
    expect(within(row).queryByText("Working…")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Approve request from/ }));
    await waitFor(() => expect(row).toHaveAttribute("aria-busy", "true"));
    expect(within(row).getByText("Working…")).toBeInTheDocument();

    resolve({ ok: false, error: "Nope." });
    await waitFor(() => expect(row).not.toHaveAttribute("aria-busy", "true"));
    expect(within(row).queryByText("Working…")).not.toBeInTheDocument();
  });

  it("shows the error, keeps the buttons usable and refreshes, since the row may be stale", async () => {
    mockApprove.mockResolvedValue({ ok: false, error: "Grant is not pending review. Refresh the page." });
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);
    await user.click(screen.getByRole("button", { name: /Approve request from/ }));

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveTextContent("Grant is not pending review."));
    expect(alert).toHaveTextContent("Ada Lovelace");
    expect(alert).toHaveTextContent("Error.");
    expect(mockRefresh).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Approve request from/ })).not.toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });

  it("shows a generic failure when the action throws (e.g. an expired session)", async () => {
    mockApprove.mockRejectedValue(new Error("Unauthorized"));
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);
    await user.click(screen.getByRole("button", { name: /Approve request from/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The request failed. Reload before retrying.");
    expect(alert).toHaveTextContent("Ada Lovelace");
    expect(alert).not.toHaveTextContent("Unauthorized");
  });

  it("locks the row after a success so a second click cannot overwrite the approval text", async () => {
    mockApprove.mockResolvedValue({ ok: true, kind: "approved", mail: "sent" });
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);

    await user.click(screen.getByRole("button", { name: /Approve request from/ }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("approval email was sent"));

    // The refresh has not removed the row (the mock does nothing): both buttons stay locked.
    expect(screen.getByRole("button", { name: /Approve request from/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: /Reject request from/ })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("button", { name: /Approve request from/ }));
    await user.click(screen.getByRole("button", { name: /Reject request from/ }));
    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(mockReject).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("approval email was sent");
  });

  it("locks the row after an approval whose email did not go, too", async () => {
    mockApprove.mockResolvedValue({ ok: true, kind: "approved", mail: "send_failed" });
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);
    await user.click(screen.getByRole("button", { name: /Approve request from/ }));
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Approve request from/ })).toHaveAttribute("aria-disabled", "true")
    );
  });

  it("releases the success lock after a timeout if the refresh never replaces the row", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      mockApprove.mockResolvedValue({ ok: true, kind: "approved", mail: "sent" });
      render(<AccessQueue grants={[makeGrant()]} />);
      const approve = screen.getByRole("button", { name: /Approve request from/ });
      await act(async () => {
        fireEvent.click(approve);
      });
      expect(approve).toHaveAttribute("aria-disabled", "true");

      await act(async () => {
        vi.advanceTimersByTime(LOCK_RELEASE_MS - 1);
      });
      expect(approve).toHaveAttribute("aria-disabled", "true");
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(approve).not.toHaveAttribute("aria-disabled", "true");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AccessQueue: focus after an action (WCAG 2.4.3)", () => {
  const queueHeading = () => screen.getByRole("heading", { level: 2, name: /Review queue/ });

  it("moves focus to the queue heading after an approval, even when the row then leaves", async () => {
    mockApprove.mockResolvedValue({ ok: true, kind: "approved", mail: "sent" });
    const user = userEvent.setup();
    const { rerender } = render(<AccessQueue grants={[makeGrant()]} />);
    screen.getByRole("button", { name: /Approve request from/ }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(queueHeading()).toHaveFocus());

    rerender(<AccessQueue grants={[]} />);
    expect(queueHeading()).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it("moves focus to the queue heading when the action is refused", async () => {
    mockReject.mockResolvedValue({ ok: false, error: "Could not reject." });
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);
    await user.click(screen.getByRole("button", { name: /Reject request from/ }));
    await waitFor(() => expect(queueHeading()).toHaveFocus());
  });

  it("moves focus to the queue heading when the action throws", async () => {
    mockApprove.mockRejectedValue(new Error("Unauthorized"));
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);
    await user.click(screen.getByRole("button", { name: /Approve request from/ }));
    await waitFor(() => expect(queueHeading()).toHaveFocus());
  });

  it("leaves focus in another row's note when a slow action completes after the admin moved there", async () => {
    let resolveApprove: (value: unknown) => void = () => {};
    mockApprove.mockReturnValue(new Promise((resolve) => (resolveApprove = resolve)));
    const user = userEvent.setup();
    render(
      <AccessQueue
        grants={[makeGrant(), makeGrant({ id: "g2", name: "Grace Hopper", email: "grace@example.org" })]}
      />
    );
    await user.click(screen.getByRole("button", { name: "Approve request from Ada Lovelace" }));

    const otherNote = within(screen.getByRole("article", { name: /Grace Hopper/ })).getByLabelText(/Internal note/);
    await user.click(otherNote);
    await user.keyboard("typing");
    expect(otherNote).toHaveFocus();

    await act(async () => {
      resolveApprove({ ok: true, kind: "approved", mail: "sent" });
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Approved the request from Ada Lovelace"));
    expect(otherNote).toHaveFocus();
    expect(otherNote).toHaveValue("typing");
  });

  it("has no element labelled 'Action results'; the status and alert regions are still there", async () => {
    mockApprove.mockResolvedValue({ ok: true, kind: "approved", mail: "sent" });
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);
    expect(screen.queryByLabelText("Action results")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Approve request from/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("Approved the request from Ada Lovelace");
  });
});

describe("AccessQueue: reject", () => {
  it("passes both notes and reports the outcome", async () => {
    mockReject.mockResolvedValue({ ok: true, mail: "sent" });
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);

    await user.type(screen.getByLabelText(/Internal note/), "Not a journalist");
    await user.type(screen.getByLabelText(/Note sent to the requester/), "We could not verify your role");
    await user.click(screen.getByRole("button", { name: /Reject request from Ada Lovelace/ }));

    await waitFor(() =>
      expect(mockReject).toHaveBeenCalledWith("g1", {
        reviewNote: "Not a journalist",
        rejectionNote: "We could not verify your role",
      })
    );
    const status = await screen.findByRole("status");
    await waitFor(() => expect(status).toHaveTextContent("rejection email was sent"));
    expect(screen.getByRole("button", { name: /Reject request from/ })).toHaveAttribute("aria-disabled", "true");
    expect(status).toHaveTextContent("Ada Lovelace");
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("says the requester was not told when the rejection mail did not go", async () => {
    mockReject.mockResolvedValue({ ok: true, mail: "send_failed" });
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);
    await user.click(screen.getByRole("button", { name: /Reject request from/ }));

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveTextContent("The requester was not told."));
    expect(alert).toHaveTextContent("send_failed");
  });

  it("shows the error when rejecting fails", async () => {
    mockReject.mockResolvedValue({ ok: false, error: "Could not reject." });
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);
    await user.click(screen.getByRole("button", { name: /Reject request from/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not reject."));
    expect(screen.getByRole("alert")).toHaveTextContent("Error.");
  });

  it("shows a generic failure when rejecting throws", async () => {
    mockReject.mockRejectedValue(new Error("Unauthorized"));
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);
    await user.click(screen.getByRole("button", { name: /Reject request from/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The request failed. Reload before retrying.");
    expect(alert).toHaveTextContent("Ada Lovelace");
  });

  it("refreshes when rejecting is not eligible, and keeps the row usable", async () => {
    mockReject.mockResolvedValue({ ok: false, error: "Could not reject. Refresh the page." });
    const user = userEvent.setup();
    render(<AccessQueue grants={[makeGrant()]} />);
    await user.click(screen.getByRole("button", { name: /Reject request from/ }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /Reject request from/ })).not.toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });
});
