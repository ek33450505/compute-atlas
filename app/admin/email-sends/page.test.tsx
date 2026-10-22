import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

const { mockList, mockCount } = vi.hoisted(() => ({ mockList: vi.fn(), mockCount: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/app/admin/email-sends/actions", () => ({ lookupEmailSendsAction: vi.fn() }));
vi.mock("@/lib/email-sends-query", async (orig) => ({
  ...(await orig<typeof import("@/lib/email-sends-query")>()),
  listEmailSends: mockList,
  countEmailSendsByOutcome: mockCount,
}));

import AdminEmailSendsPage from "./page";

const row = {
  id: "r1",
  createdAt: new Date("2026-10-01T12:00:00Z"),
  completedAt: new Date("2026-10-01T12:00:01Z"),
  kind: "confirm",
  outcome: "sent",
  targetType: null,
  targetId: null,
  runId: null,
  resendId: "re_123",
  errorCode: null,
  subscriptionId: null,
  hashPrefix: "abcd1234",
};

describe("AdminEmailSendsPage", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockList.mockResolvedValue([row]);
    mockCount.mockResolvedValue({ sent: 3, error: 1 });
  });

  it("renders the table, outcome counts and labelled filters, passing only valid params", async () => {
    render(
      await AdminEmailSendsPage({
        searchParams: Promise.resolve({ kind: "confirm", outcome: "bogus", since: "2026-10-01" }),
      })
    );
    expect(screen.getByRole("heading", { name: "Email sends" })).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("re_123")).toBeInTheDocument();
    const counts = screen.getByRole("region", { name: "Counts by outcome" });
    expect(within(counts).getByText("sent: 3")).toBeInTheDocument();
    expect(within(counts).getByText("error: 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Kind")).toHaveValue("confirm");
    expect(screen.getByLabelText("From")).toHaveValue("2026-10-01");
    expect(mockList).toHaveBeenCalledWith(
      {},
      { kind: "confirm", outcome: undefined, since: "2026-10-01", until: undefined }
    );
    expect(screen.getByRole("heading", { name: "Look up an address" })).toBeInTheDocument();
  });
});
