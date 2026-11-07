import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockHasAdminSession } = vi.hoisted(() => ({ mockHasAdminSession: vi.fn() }));

vi.mock("@/lib/admin-session", () => ({
  hasAdminSession: mockHasAdminSession,
}));

vi.mock("@/app/admin/refresh-site-button", () => ({
  RefreshSiteButton: () => <button type="button">Refresh site</button>,
}));

import { RefreshSiteSlot } from "./refresh-site-slot";

describe("RefreshSiteSlot", () => {
  beforeEach(() => {
    mockHasAdminSession.mockReset();
  });

  it("renders nothing without a valid session", async () => {
    mockHasAdminSession.mockResolvedValue(false);

    render(await RefreshSiteSlot());

    expect(screen.queryByRole("button", { name: "Refresh site" })).toBeNull();
  });

  it("renders the button with a valid session", async () => {
    mockHasAdminSession.mockResolvedValue(true);

    render(await RefreshSiteSlot());

    expect(screen.getByRole("button", { name: "Refresh site" })).toBeInTheDocument();
  });
});
