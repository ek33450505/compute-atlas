import { vi, describe, it, expect, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ListGrant } from "./grant-views";
import { DATASET_GRANT_STATUSES } from "@/lib/db/schema";

const { mockRefresh, mockRevoke, mockReissue, mockExtend } = vi.hoisted(() => ({
  mockRefresh: vi.fn(),
  mockRevoke: vi.fn(),
  mockReissue: vi.fn(),
  mockExtend: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("@/app/admin/access/actions", () => ({
  revokeDatasetGrantAction: mockRevoke,
  reissueDatasetLinkAction: mockReissue,
  extendDatasetGrantAction: mockExtend,
}));

import { GrantsList, GRANT_STATUSES } from "./grants-list";
import { LOCK_RELEASE_MS } from "./shared";

const FUTURE = new Date("2027-06-01T00:00:00Z");
const PAST = new Date("2026-10-01T00:00:00Z");

function makeGrant(overrides: Partial<ListGrant> = {}): ListGrant {
  return {
    id: "g1",
    createdAt: new Date("2026-06-01T10:00:00Z"),
    email: "ada@example.org",
    name: "Ada Lovelace",
    organization: "Analytical Engines",
    status: "active",
    approvedAt: new Date("2026-06-02T00:00:00Z"),
    reviewNote: null,
    rejectionNote: null,
    revokedAt: null,
    revokeReason: null,
    expiresAt: FUTURE,
    renewalRequestedAt: null,
    lastDownloadAt: null,
    downloadCount: 0,
    live: true,
    renewalPending: false,
    ...overrides,
  };
}

function rowFor(name: string) {
  return screen.getByRole("article", { name: new RegExp(name) });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GrantsList: filter and listing", () => {
  it("keeps its local status list in step with the schema", () => {
    expect([...GRANT_STATUSES]).toEqual([...DATASET_GRANT_STATUSES]);
  });

  it("links to every status and marks only the active one as current", () => {
    render(<GrantsList grants={[]} activeStatus="expired" />);
    expect(screen.getByRole("heading", { level: 2, name: "Grants" })).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: /status/i });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "?status=unverified",
      "?status=pending_review",
      "?status=active",
      "?status=expired",
      "?status=revoked",
      "?status=rejected",
    ]);
    const current = links.filter((l) => l.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute("href", "?status=expired");
  });

  it("shows an empty state naming the status", () => {
    render(<GrantsList grants={[]} activeStatus="revoked" />);
    expect(screen.getByText("No revoked grants.")).toBeInTheDocument();
  });

  it("shows a pending-review empty state without the underscore", () => {
    render(<GrantsList grants={[]} activeStatus="pending_review" />);
    expect(screen.getByText("No pending review grants.")).toBeInTheDocument();
  });

  it("labels the email as verified and the organization as not verified", () => {
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);
    const row = rowFor("Ada Lovelace");
    expect(within(row).getByText("Email (verified)")).toBeInTheDocument();
    expect(within(row).getByText("ada@example.org")).toBeInTheDocument();
    expect(within(row).getByText(/Organization \(as submitted, not verified\)/)).toBeInTheDocument();
    expect(within(row).getByText("Analytical Engines")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Unauthenticated: names and organizations are as submitted, not verified\. Only the email address was verified\./
      )
    ).toBeInTheDocument();
  });

  it("renders every free-text field as inert text, never markup or an anchor", () => {
    const img = "<img src=x onerror=alert(1)>";
    const js = "javascript:alert(1)";
    const { container } = render(
      <GrantsList
        grants={[
          makeGrant({
            name: img,
            organization: js,
            reviewNote: img,
            rejectionNote: js,
            revokeReason: `${img} ${js}`,
          }),
        ]}
        activeStatus="active"
      />
    );
    // name (heading) + reviewNote render the markup string as text; organization + rejectionNote the URL string.
    expect(screen.getAllByText(img).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(js).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(`${img} ${js}`)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href).toMatch(/^\?status=/);
    }
  });

  it("shows status, downloads, notes and the download-log link", () => {
    render(
      <GrantsList
        grants={[
          makeGrant({
            downloadCount: 7,
            lastDownloadAt: new Date("2026-09-15T00:00:00Z"),
            reviewNote: "Checked byline",
          }),
        ]}
        activeStatus="active"
      />
    );
    const row = rowFor("Ada Lovelace");
    expect(within(row).getByText("active")).toBeInTheDocument();
    expect(within(row).getByText("7")).toBeInTheDocument();
    expect(within(row).getByText("Checked byline")).toBeInTheDocument();
    const log = within(row).getByRole("link", { name: /Download log/ });
    expect(log).toHaveAttribute("href", "?status=active&grant=g1");
  });

  it("shows rejection note and revoke reason when present", () => {
    render(
      <GrantsList
        grants={[
          makeGrant({ id: "x", name: "Rejected One", status: "rejected", live: false, rejectionNote: "Not eligible" }),
          makeGrant({
            id: "y",
            name: "Revoked One",
            status: "revoked",
            live: false,
            revokeReason: "Shared the link publicly",
          }),
        ]}
        activeStatus="rejected"
      />
    );
    expect(within(rowFor("Rejected One")).getByText("Not eligible")).toBeInTheDocument();
    expect(within(rowFor("Revoked One")).getByText("Shared the link publicly")).toBeInTheDocument();
  });

  it("flags a renewal pending past expiry as paused", () => {
    render(
      <GrantsList
        grants={[makeGrant({ live: false, expiresAt: PAST, renewalPending: true })]}
        activeStatus="active"
      />
    );
    expect(within(rowFor("Ada Lovelace")).getByText(/downloads are paused/)).toBeInTheDocument();
  });
});

describe("GrantsList: which actions appear", () => {
  const names = (row: HTMLElement) =>
    within(row)
      .queryAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));

  it("live active grant: Extend, Reissue and Revoke", () => {
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);
    expect(names(rowFor("Ada Lovelace"))).toEqual([
      "Extend access for Ada Lovelace",
      "Reissue link for Ada Lovelace",
      "Revoke access for Ada Lovelace",
    ]);
  });

  it("lapsed active grant: Revoke only, no Reissue and no Extend", () => {
    render(
      <GrantsList grants={[makeGrant({ live: false, expiresAt: PAST })]} activeStatus="active" />
    );
    expect(names(rowFor("Ada Lovelace"))).toEqual(["Revoke access for Ada Lovelace"]);
  });

  it("renewal-pending lapsed grant: Extend and Revoke, still no Reissue", () => {
    render(
      <GrantsList
        grants={[makeGrant({ live: false, expiresAt: PAST, renewalPending: true })]}
        activeStatus="active"
      />
    );
    expect(names(rowFor("Ada Lovelace"))).toEqual([
      "Extend access for Ada Lovelace",
      "Revoke access for Ada Lovelace",
    ]);
  });

  it.each(["rejected", "revoked", "expired", "pending_review", "unverified"] as const)(
    "%s grant: no actions",
    (status) => {
      render(<GrantsList grants={[makeGrant({ status, live: false })]} activeStatus={status} />);
      expect(within(rowFor("Ada Lovelace")).queryAllByRole("button")).toHaveLength(0);
    }
  );
});

describe("GrantsList: revoke", () => {
  it("needs a confirm step, says no email is sent, and passes the reason", async () => {
    mockRevoke.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);

    await user.click(screen.getByRole("button", { name: "Revoke access for Ada Lovelace" }));
    expect(mockRevoke).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("The link stops working at once. No email is sent to the requester.");
    await user.type(within(dialog).getByLabelText(/Reason/), "Shared publicly");
    await user.click(within(dialog).getByRole("button", { name: "Confirm revoke" }));

    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith("g1", "Shared publicly"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Revoked access for Ada Lovelace"));
    expect(screen.getByRole("status")).toHaveTextContent("No email was sent");
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("never calls the action when the confirm step is cancelled", async () => {
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);

    await user.click(screen.getByRole("button", { name: "Revoke access for Ada Lovelace" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("shows the error when revoking fails", async () => {
    mockRevoke.mockResolvedValue({ ok: false, error: "Grant is not active." });
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);

    await user.click(screen.getByRole("button", { name: /Revoke access for/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm revoke" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Grant is not active."));
    expect(screen.getByRole("alert")).toHaveTextContent("Error.");
    // Not eligible: the row may be stale, so it refreshes, and the buttons stay usable.
    expect(mockRefresh).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Revoke access for/ })).not.toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });

  it("shows a generic failure and closes the dialog when revoking throws", async () => {
    mockRevoke.mockRejectedValue(new Error("Unauthorized"));
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);

    await user.click(screen.getByRole("button", { name: /Revoke access for/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm revoke" }));

    const alert = await screen.findByText(/The request failed\. Reload before retrying\./);
    expect(screen.getByRole("alert")).toContainElement(alert);
    expect(screen.getByRole("alert")).toHaveTextContent("Ada Lovelace");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Unauthorized");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("locks the row's buttons after a success until a refreshed row arrives", async () => {
    mockRevoke.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const grant = makeGrant();
    const { rerender } = render(<GrantsList grants={[grant]} activeStatus="active" />);

    await user.click(screen.getByRole("button", { name: "Revoke access for Ada Lovelace" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Revoked access"));

    const row = rowFor("Ada Lovelace");
    for (const button of within(row).getAllByRole("button")) {
      expect(button).toHaveAttribute("aria-disabled", "true");
    }

    // Same object (refresh not landed): still locked. A fresh object (refresh landed): usable again.
    rerender(<GrantsList grants={[grant]} activeStatus="active" />);
    expect(within(rowFor("Ada Lovelace")).getByRole("button", { name: /Extend access/ })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    rerender(<GrantsList grants={[{ ...grant }]} activeStatus="active" />);
    expect(within(rowFor("Ada Lovelace")).getByRole("button", { name: /Extend access/ })).not.toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(screen.getByRole("status")).toHaveTextContent("Revoked access");
  });
});

describe("GrantsList: reissue", () => {
  it("needs a confirm step that states the consequences", async () => {
    mockReissue.mockResolvedValue({ ok: true, mail: "sent" });
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);

    await user.click(screen.getByRole("button", { name: "Reissue link for Ada Lovelace" }));
    expect(mockReissue).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("The current link stops working at once and a new link is emailed.");
    await user.click(within(dialog).getByRole("button", { name: "Confirm reissue" }));

    await waitFor(() => expect(mockReissue).toHaveBeenCalledWith("g1"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("new-link email was sent"));
    expect(screen.getByRole("status")).toHaveTextContent("Ada Lovelace");
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("says the requester has no link when the new mail did not go", async () => {
    mockReissue.mockResolvedValue({ ok: true, mail: "skipped_suppressed" });
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);

    await user.click(screen.getByRole("button", { name: /Reissue link for/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm reissue" }));

    const alert = screen.getByRole("alert");
    await waitFor(() => expect(alert).toHaveTextContent("does NOT have their link"));
    expect(alert).toHaveTextContent("skipped_suppressed");
    expect(within(alert).getByText(/Not delivered/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("never calls the action when cancelled", async () => {
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);
    await user.click(screen.getByRole("button", { name: /Reissue link for/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(mockReissue).not.toHaveBeenCalled();
  });

  it("shows the refusal (e.g. a cooldown) and refreshes", async () => {
    mockReissue.mockResolvedValue({ ok: false, error: "A link was reissued a moment ago. Try again later." });
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);
    await user.click(screen.getByRole("button", { name: /Reissue link for/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm reissue" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("A link was reissued a moment ago."));
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("shows a generic failure and closes the dialog when reissuing throws", async () => {
    mockReissue.mockRejectedValue(new Error("Unauthorized"));
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);
    await user.click(screen.getByRole("button", { name: /Reissue link for/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm reissue" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("The request failed. Reload before retrying.")
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("GrantsList: extend", () => {
  it("extends in one step and reports no email", async () => {
    mockExtend.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);

    await user.click(screen.getByRole("button", { name: "Extend access for Ada Lovelace" }));

    await waitFor(() => expect(mockExtend).toHaveBeenCalledWith("g1"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Extended access for Ada Lovelace"));
    expect(screen.getByRole("status")).toHaveTextContent("No email is sent.");
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("shows the error when extending fails", async () => {
    mockExtend.mockResolvedValue({ ok: false, error: "Could not extend." });
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);
    await user.click(screen.getByRole("button", { name: /Extend access for/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not extend."));
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("shows a generic failure when extending throws", async () => {
    mockExtend.mockRejectedValue(new Error("Unauthorized"));
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);
    await user.click(screen.getByRole("button", { name: /Extend access for/ }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("The request failed. Reload before retrying.")
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Ada Lovelace");
  });
});

describe("GrantsList: locked controls keep focus (WCAG 2.4.3)", () => {
  it("keeps focus on Extend while pending, marks the row busy and ignores a second activation", async () => {
    let resolve!: (value: unknown) => void;
    mockExtend.mockReturnValue(new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);

    const row = rowFor("Ada Lovelace");
    expect(row).not.toHaveAttribute("aria-busy", "true");
    const extend = screen.getByRole("button", { name: "Extend access for Ada Lovelace" });
    extend.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(extend).toHaveAttribute("aria-disabled", "true"));
    expect(extend).not.toBeDisabled();
    expect(extend).toHaveFocus();
    expect(row).toHaveAttribute("aria-busy", "true");
    expect(within(row).getByText("Working…")).toBeInTheDocument();
    for (const button of within(row).getAllByRole("button")) {
      expect(button).toHaveAttribute("aria-disabled", "true");
    }

    await user.keyboard("{Enter}");
    await user.click(extend);
    expect(mockExtend).toHaveBeenCalledTimes(1);

    resolve({ ok: false, error: "Nope." });
    await waitFor(() => expect(row).not.toHaveAttribute("aria-busy", "true"));
    expect(within(row).queryByText("Working…")).not.toBeInTheDocument();
  });

  it("keeps focus on the confirm button while the revoke is pending, and ignores a second activation", async () => {
    let resolve!: (value: unknown) => void;
    mockRevoke.mockReturnValue(new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);

    await user.click(screen.getByRole("button", { name: "Revoke access for Ada Lovelace" }));
    const confirm = within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm revoke" });
    confirm.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(confirm).toHaveAttribute("aria-disabled", "true"));
    expect(confirm).not.toBeDisabled();
    expect(confirm).toHaveFocus();

    await user.keyboard("{Enter}");
    await user.click(confirm);
    expect(mockRevoke).toHaveBeenCalledTimes(1);
    resolve({ ok: false, error: "Nope." });
  });

  it("releases the success lock after a timeout if the refresh never replaces the row", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      mockExtend.mockResolvedValue({ ok: true });
      render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);
      const extend = screen.getByRole("button", { name: /Extend access for/ });
      await act(async () => {
        fireEvent.click(extend);
      });
      expect(extend).toHaveAttribute("aria-disabled", "true");

      await act(async () => {
        vi.advanceTimersByTime(LOCK_RELEASE_MS - 1);
      });
      expect(extend).toHaveAttribute("aria-disabled", "true");
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(extend).not.toHaveAttribute("aria-disabled", "true");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("GrantsList: focus after an action (WCAG 2.4.3)", () => {
  const grantsHeading = () => screen.getByRole("heading", { level: 2, name: "Grants" });

  it("moves focus to the grants heading after Extend succeeds", async () => {
    mockExtend.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);
    screen.getByRole("button", { name: /Extend access for/ }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(grantsHeading()).toHaveFocus());
  });

  it("moves focus to the grants heading after Extend is refused or throws", async () => {
    mockExtend.mockResolvedValueOnce({ ok: false, error: "Could not extend." });
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);
    await user.click(screen.getByRole("button", { name: /Extend access for/ }));
    await waitFor(() => expect(grantsHeading()).toHaveFocus());

    (document.activeElement as HTMLElement).blur();
    mockExtend.mockRejectedValueOnce(new Error("Unauthorized"));
    await user.click(screen.getByRole("button", { name: /Extend access for/ }));
    await waitFor(() => expect(grantsHeading()).toHaveFocus());
  });

  it("leaves focus on an element outside the acting row when a slow Extend completes after the admin moved there", async () => {
    let resolveExtend: (value: unknown) => void = () => {};
    mockExtend.mockReturnValue(new Promise((resolve) => (resolveExtend = resolve)));
    const user = userEvent.setup();
    render(
      <GrantsList
        grants={[makeGrant(), makeGrant({ id: "g2", name: "Grace Hopper", email: "grace@example.org" })]}
        activeStatus="active"
      />
    );
    await user.click(screen.getByRole("button", { name: "Extend access for Ada Lovelace" }));

    // The other row's textarea is only in its (closed) revoke dialog, so use a stand-in focus target.
    const stray = document.createElement("textarea");
    document.body.appendChild(stray);
    try {
      stray.focus();
      await act(async () => {
        resolveExtend({ ok: true });
      });
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Extended access for Ada Lovelace"));
      expect(stray).toHaveFocus();
    } finally {
      stray.remove();
    }
  });

  it("has no element labelled 'Action results'; the status and alert regions are still there", () => {
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);
    expect(screen.queryByLabelText("Action results")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("puts focus on the grants heading, not <body>, once a confirmed revoke closes the dialog", async () => {
    mockRevoke.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const grant = makeGrant();
    const { rerender } = render(<GrantsList grants={[grant]} activeStatus="active" />);

    await user.click(screen.getByRole("button", { name: "Revoke access for Ada Lovelace" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The refresh removes the row (and with it the dialog's trigger): focus must not fall to <body>.
    rerender(<GrantsList grants={[]} activeStatus="active" />);
    await waitFor(() => expect(grantsHeading()).toHaveFocus());
    expect(document.body).not.toHaveFocus();
  });

  it("puts focus on the grants heading once a confirmed reissue closes the dialog", async () => {
    mockReissue.mockResolvedValue({ ok: true, mail: "sent" });
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);

    await user.click(screen.getByRole("button", { name: "Reissue link for Ada Lovelace" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm reissue" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(grantsHeading()).toHaveFocus());
  });

  it("puts focus on the grants heading when a confirmed revoke is refused", async () => {
    mockRevoke.mockResolvedValue({ ok: false, error: "Grant is not active." });
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);

    await user.click(screen.getByRole("button", { name: /Revoke access for/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(grantsHeading()).toHaveFocus());
  });

  it("still returns focus to the button that opened a dialog that is cancelled", async () => {
    const user = userEvent.setup();
    render(<GrantsList grants={[makeGrant()]} activeStatus="active" />);

    const revoke = screen.getByRole("button", { name: "Revoke access for Ada Lovelace" });
    await user.click(revoke);
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(revoke).toHaveFocus());
  });
});
