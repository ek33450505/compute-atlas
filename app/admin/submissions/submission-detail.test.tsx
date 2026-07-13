import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import type { SubmissionRow } from "@/lib/db/schema";
import type { Facility } from "@/lib/schema";

// vi.mock calls are hoisted above imports by Vitest. Route the shared mock
// through vi.hoisted() so its initialization is hoisted alongside the
// vi.mock call itself, rather than relying on a plain top-level const.
const { mockGetFacilityById } = vi.hoisted(() => ({
  mockGetFacilityById: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getFacilityById: mockGetFacilityById,
}));

import { SubmissionDetail } from "./submission-detail";

function makeSubmission(overrides: Partial<SubmissionRow> = {}): SubmissionRow {
  return {
    id: "sub-1",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    status: "pending",
    kind: "create",
    targetFacilityId: null,
    payload: {},
    provenance: { sources: [], discoveredBy: "manual" },
    reviewNote: null,
    reviewedAt: null,
    ...overrides,
  } as SubmissionRow;
}

describe("SubmissionDetail — kind=create", () => {
  it("renders a readable summary of top-level payload fields", async () => {
    const submission = makeSubmission({
      kind: "create",
      payload: { name: "New Site", operator: "Acme Co", status: "planned" },
    });

    render(await SubmissionDetail({ submission }));

    expect(screen.getByText("New Site")).toBeInTheDocument();
    expect(screen.getByText("Acme Co")).toBeInTheDocument();
    expect(screen.getByText("planned")).toBeInTheDocument();
  });

  it("never calls getFacilityById for a create-kind submission", async () => {
    const submission = makeSubmission({ kind: "create", payload: { name: "X" } });
    render(await SubmissionDetail({ submission }));
    expect(mockGetFacilityById).not.toHaveBeenCalled();
  });
});

describe("SubmissionDetail — kind=update", () => {
  beforeEach(() => {
    mockGetFacilityById.mockClear();
  });

  it("renders a shallow before/after diff only for top-level keys present in the patch", async () => {
    const liveFacility = {
      id: "fac-1",
      name: "Existing Facility",
      status: "planned",
      operator: "Acme Co",
    } as unknown as Facility;
    mockGetFacilityById.mockResolvedValue(liveFacility);

    const submission = makeSubmission({
      kind: "update",
      targetFacilityId: "fac-1",
      payload: { status: "operational" },
    });

    render(await SubmissionDetail({ submission }));

    expect(mockGetFacilityById).toHaveBeenCalledWith("fac-1");
    // Changed key surfaces with before/after.
    expect(screen.getByText("status")).toBeInTheDocument();
    expect(screen.getByText("planned")).toBeInTheDocument();
    expect(screen.getByText("operational")).toBeInTheDocument();
    // Unchanged keys not present in the patch are not rendered as a diff row.
    expect(screen.queryByText("operator")).not.toBeInTheDocument();
  });

  it("reports no changes when the patch value matches the live value", async () => {
    mockGetFacilityById.mockResolvedValue({
      id: "fac-1",
      status: "operational",
    } as unknown as Facility);

    const submission = makeSubmission({
      kind: "update",
      targetFacilityId: "fac-1",
      payload: { status: "operational" },
    });

    render(await SubmissionDetail({ submission }));

    expect(screen.getByText("No field-level changes detected.")).toBeInTheDocument();
  });

  it("falls back to a raw payload summary when the target facility no longer exists", async () => {
    mockGetFacilityById.mockResolvedValue(undefined);

    const submission = makeSubmission({
      kind: "update",
      targetFacilityId: "deleted-facility",
      payload: { status: "operational" },
    });

    render(await SubmissionDetail({ submission }));

    expect(screen.getByText(/no longer exists/)).toBeInTheDocument();
    expect(screen.getByText("operational")).toBeInTheDocument();
  });
});
