import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockHasSession, mockLoadFacilities, mockRedirect, mockNotFound } = vi.hoisted(() => ({
  mockHasSession: vi.fn(),
  mockLoadFacilities: vi.fn(),
  mockRedirect: vi.fn(),
  mockNotFound: vi.fn(),
}));

vi.mock("@/lib/admin-session", () => ({ hasAdminSession: mockHasSession }));
vi.mock("@/lib/data", () => ({ loadFacilities: mockLoadFacilities }));
// Like the real ones, redirect() and notFound() never return: they throw.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    mockRedirect(url);
    throw new Error("NEXT_REDIRECT");
  },
  notFound: () => {
    mockNotFound();
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/app/admin/facilities/facility-form", () => ({ FacilityForm: () => null }));
vi.mock("@/app/admin/facilities/[id]/history-panel", () => ({ HistoryPanel: () => null }));

import EditFacilityPage from "./page";

describe("/admin/facilities/[id] page session guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to /admin/login without a session, before reading params or data", async () => {
    mockHasSession.mockResolvedValue(false);
    // A params promise that fails the test if it is ever awaited.
    const params = {
      then() {
        throw new Error("params awaited before the session check");
      },
    } as unknown as Promise<{ id: string }>;

    await expect(EditFacilityPage({ params })).rejects.toThrow("NEXT_REDIRECT");

    expect(mockRedirect).toHaveBeenCalledWith("/admin/login");
    expect(mockLoadFacilities).not.toHaveBeenCalled();
  });

  it("redirects when the session check itself reports false for any reason (no data load)", async () => {
    mockHasSession.mockResolvedValue(false);
    await expect(EditFacilityPage({ params: Promise.resolve({ id: "x" }) })).rejects.toThrow(
      "NEXT_REDIRECT"
    );
    expect(mockLoadFacilities).not.toHaveBeenCalled();
  });

  it("with a session, does not redirect and loads facilities (404 for an unknown id)", async () => {
    mockHasSession.mockResolvedValue(true);
    mockLoadFacilities.mockResolvedValue([{ id: "known", name: "Known" }]);

    await expect(EditFacilityPage({ params: Promise.resolve({ id: "missing" }) })).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockLoadFacilities).toHaveBeenCalledTimes(1);
  });
});
