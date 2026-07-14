import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mock
// db through vi.hoisted() so its rows can be reassigned per test.
const { mockDb, setHistoryRows } = vi.hoisted(() => {
  let historyRows: unknown[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(historyRows),
        }),
      }),
    }),
  };
  return {
    mockDb: db,
    setHistoryRows: (rows: unknown[]) => {
      historyRows = rows;
    },
  };
});

vi.mock("@/lib/db/client", () => ({
  getDb: () => mockDb,
}));

import { HistoryPanel } from "./history-panel";

function makeHistoryRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "hist-1",
    facilityId: "facility-a",
    changedAt: new Date("2026-07-13T12:00:00Z"),
    changeType: "update",
    diff: [{ key: "status", before: "planned", after: "operational" }],
    source: "admin-direct",
    ...overrides,
  };
}

describe("HistoryPanel", () => {
  beforeEach(() => {
    setHistoryRows([]);
  });

  it("renders the empty state when a facility has no history rows", async () => {
    render(await HistoryPanel({ facilityId: "facility-a" }));
    expect(screen.getByText("No history recorded for this facility yet.")).toBeInTheDocument();
  });

  it("renders each history entry with its change type, source, and diff", async () => {
    setHistoryRows([makeHistoryRow()]);

    render(await HistoryPanel({ facilityId: "facility-a" }));

    expect(screen.getByText("Updated")).toBeInTheDocument();
    expect(screen.getByText(/admin-direct/)).toBeInTheDocument();
    expect(screen.getByText("status")).toBeInTheDocument();
    expect(screen.getByText("planned")).toBeInTheDocument();
    expect(screen.getByText("operational")).toBeInTheDocument();
  });

  it("renders create and delete change types with readable labels", async () => {
    setHistoryRows([
      makeHistoryRow({ id: "hist-2", changeType: "create", diff: [] }),
      makeHistoryRow({ id: "hist-3", changeType: "delete", diff: [] }),
    ]);

    render(await HistoryPanel({ facilityId: "facility-a" }));

    expect(screen.getByText("Created")).toBeInTheDocument();
    expect(screen.getByText("Deleted")).toBeInTheDocument();
  });

  it("falls back to the raw changeType string for an unrecognized value", async () => {
    setHistoryRows([makeHistoryRow({ id: "hist-4", changeType: "restore", diff: [] })]);

    render(await HistoryPanel({ facilityId: "facility-a" }));

    expect(screen.getByText("restore")).toBeInTheDocument();
  });
});
