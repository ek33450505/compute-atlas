import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockQueue, mockList, mockLog, mockHasSession, mockRedirect, queueProps, listProps } = vi.hoisted(() => ({
  mockQueue: vi.fn(),
  mockList: vi.fn(),
  mockLog: vi.fn(),
  mockHasSession: vi.fn(),
  mockRedirect: vi.fn(),
  queueProps: vi.fn(),
  listProps: vi.fn(),
}));

vi.mock("@/lib/admin-session", () => ({ hasAdminSession: mockHasSession }));
// Like the real one, redirect() never returns: it throws, so nothing after it runs.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    mockRedirect(url);
    throw new Error("NEXT_REDIRECT");
  },
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/dataset-admin", async (orig) => ({
  ...(await orig<typeof import("@/lib/dataset-admin")>()),
  listDatasetReviewQueue: mockQueue,
  listDatasetGrantsForAdmin: mockList,
  getDatasetDownloadLog: mockLog,
}));
vi.mock("@/app/admin/access/access-queue", () => ({
  AccessQueue: (props: { grants: unknown[] }) => {
    queueProps(props);
    return <div>queue size {props.grants.length}</div>;
  },
}));
vi.mock("@/app/admin/access/grants-list", () => ({
  GrantsList: (props: { grants: unknown[]; activeStatus: string }) => {
    listProps(props);
    return (
      <div>
        list size {props.grants.length} status {props.activeStatus}
      </div>
    );
  },
}));

import type { AdminDatasetGrant } from "@/lib/dataset-admin";
import AdminAccessPage, { dynamic } from "./page";

const log = {
  grant: {
    id: "g1",
    name: "Ada Lovelace",
    email: "ada@example.org",
    status: "active" as const,
    downloadCount: 2,
    lastDownloadAt: new Date("2026-11-01T10:00:00Z"),
  },
  downloads: [],
};

/** Every column, including the ones no component shows (internal note, verification stamps). */
const fullGrant: AdminDatasetGrant = {
  id: "g1",
  createdAt: new Date("2026-11-01T10:00:00Z"),
  email: "ada@example.org",
  name: "Ada Lovelace",
  organization: "Analytical Engines",
  role: "Reporter",
  category: "journalist",
  intendedUse: "Mapping water use.",
  links: ["https://example.org/profile"],
  status: "pending_review",
  verifiedAt: new Date("2026-11-01T10:05:00Z"),
  approvedAt: null,
  reviewedAt: new Date("2026-11-02T00:00:00Z"),
  reviewNote: "internal only",
  rejectionNote: "to requester",
  revokedAt: null,
  revokeReason: null,
  expiresAt: null,
  renewalRequestedAt: null,
  lastDownloadAt: null,
  downloadCount: 0,
  live: false,
  renewalPending: false,
};

const QUEUE_KEYS = [
  "category",
  "createdAt",
  "email",
  "expiresAt",
  "id",
  "intendedUse",
  "links",
  "live",
  "name",
  "organization",
  "renewalPending",
  "renewalRequestedAt",
  "role",
  "status",
];

const LIST_KEYS = [
  "approvedAt",
  "createdAt",
  "downloadCount",
  "email",
  "expiresAt",
  "id",
  "lastDownloadAt",
  "live",
  "name",
  "organization",
  "rejectionNote",
  "renewalPending",
  "renewalRequestedAt",
  "revokeReason",
  "revokedAt",
  "reviewNote",
  "status",
].sort();

async function renderPage(params: { status?: string; grant?: string }) {
  render(await AdminAccessPage({ searchParams: Promise.resolve(params) }));
}

describe("AdminAccessPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockHasSession.mockResolvedValue(true);
    mockQueue.mockResolvedValue([fullGrant, fullGrant]);
    mockList.mockResolvedValue([fullGrant]);
    mockLog.mockResolvedValue(log);
  });

  it("renders on demand", () => {
    expect(dynamic).toBe("force-dynamic");
  });

  it("redirects to the login page and reads nothing without an admin session", async () => {
    mockHasSession.mockResolvedValue(false);

    await expect(renderPage({ grant: "g1" })).rejects.toThrow("NEXT_REDIRECT");

    expect(mockRedirect).toHaveBeenCalledWith("/admin/login");
    expect(mockQueue).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("does not redirect with a session", async () => {
    await renderPage({});

    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("hands the components only the fields they display", async () => {
    mockQueue.mockResolvedValue([fullGrant]);
    mockList.mockResolvedValue([fullGrant]);

    await renderPage({});

    const [{ grants: queued }] = queueProps.mock.calls[0] as [{ grants: Record<string, unknown>[] }];
    const [{ grants: listed }] = listProps.mock.calls[0] as [{ grants: Record<string, unknown>[] }];
    expect(Object.keys(queued[0]).sort()).toEqual(QUEUE_KEYS);
    expect(Object.keys(listed[0]).sort()).toEqual(LIST_KEYS);
    // The internal note is shown by the list only; the queue never gets it.
    expect(queued[0]).not.toHaveProperty("reviewNote");
    expect(listed[0]).not.toHaveProperty("intendedUse");
    expect(queued[0]).toMatchObject({ id: "g1", name: "Ada Lovelace" });
    expect(listed[0]).toMatchObject({ id: "g1", reviewNote: "internal only" });
  });

  it("renders the heading, the queue and the list for the default status", async () => {
    await renderPage({});

    expect(screen.getByRole("heading", { level: 1, name: "Dataset access" })).toBeInTheDocument();
    expect(screen.getByText("queue size 2")).toBeInTheDocument();
    expect(screen.getByText("list size 1 status active")).toBeInTheDocument();
    expect(mockList).toHaveBeenCalledWith("active");
  });

  it("falls back to active for an unknown status", async () => {
    await renderPage({ status: "bogus" });

    expect(mockList).toHaveBeenCalledWith("active");
    expect(screen.getByText("list size 1 status active")).toBeInTheDocument();
  });

  it("passes a valid status through", async () => {
    await renderPage({ status: "revoked" });

    expect(mockList).toHaveBeenCalledWith("revoked");
    expect(screen.getByText("list size 1 status revoked")).toBeInTheDocument();
  });

  it("does not load a download log without a grant param", async () => {
    await renderPage({});

    expect(mockLog).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: /download log/i })).toBeNull();
  });

  it("loads and renders the download log for a grant", async () => {
    await renderPage({ grant: "g1", status: "revoked" });

    expect(mockLog).toHaveBeenCalledWith("g1");
    expect(screen.getByRole("heading", { name: "Download log: Ada Lovelace" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Close log" })).toHaveAttribute(
      "href",
      "/admin/access?status=revoked"
    );
  });

  it("renders the download log between the queue and the grants list, so the Download log link lands next to it", async () => {
    await renderPage({ grant: "g1" });

    const queue = screen.getByText(/queue size/);
    const heading = screen.getByRole("heading", { name: "Download log: Ada Lovelace" });
    const list = screen.getByText(/list size/);
    expect(queue.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("moves focus to the download log heading when a log is shown", async () => {
    await renderPage({ grant: "g1" });

    expect(screen.getByRole("heading", { name: "Download log: Ada Lovelace" })).toHaveFocus();
  });

  it("says so without echoing the param when the grant is unknown", async () => {
    mockLog.mockResolvedValue(null);
    await renderPage({ grant: "<script>nope</script>" });

    expect(screen.getByText("No such grant.")).toBeInTheDocument();
    expect(screen.queryByText(/nope/)).toBeNull();
  });
});
