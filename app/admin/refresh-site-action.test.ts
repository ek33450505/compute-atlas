import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockHasAdminSession, mockRevalidateTag } = vi.hoisted(() => ({
  mockHasAdminSession: vi.fn(),
  mockRevalidateTag: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidateTag: mockRevalidateTag,
}));

vi.mock("@/lib/admin-session", () => ({
  hasAdminSession: mockHasAdminSession,
}));

import { refreshSiteAction } from "./refresh-site-action";

describe("refreshSiteAction", () => {
  beforeEach(() => {
    mockHasAdminSession.mockReset();
    mockRevalidateTag.mockReset();
  });

  it("busts nothing and fails without a valid session", async () => {
    mockHasAdminSession.mockResolvedValue(false);

    const result = await refreshSiteAction();

    expect(result).toEqual({ ok: false, error: "Refresh failed" });
    expect(mockRevalidateTag).not.toHaveBeenCalled();
  });

  it("busts the facilities tag exactly once with the max profile", async () => {
    mockHasAdminSession.mockResolvedValue(true);

    const result = await refreshSiteAction();

    expect(result).toEqual({ ok: true });
    expect(mockRevalidateTag).toHaveBeenCalledTimes(1);
    expect(mockRevalidateTag).toHaveBeenCalledWith("facilities", "max");
  });

  it("returns a fixed message, never error text, when the bust throws", async () => {
    mockHasAdminSession.mockResolvedValue(true);
    mockRevalidateTag.mockImplementation(() => {
      throw new Error("secret internal detail");
    });

    const result = await refreshSiteAction();

    expect(result).toEqual({ ok: false, error: "Refresh failed" });
  });
});
