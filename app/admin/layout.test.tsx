import { vi, describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockLogout } = vi.hoisted(() => ({
  mockLogout: vi.fn(),
}));

vi.mock("@/app/admin/login/actions", () => ({
  logout: mockLogout,
}));

// The slot is an async server component (reads cookies), which RTL cannot
// render; it is tested on its own. Stand in a plain button here.
vi.mock("@/app/admin/refresh-site-slot", () => ({
  RefreshSiteSlot: () => <button type="button">Refresh site</button>,
}));

import AdminLayout from "./layout";

describe("AdminLayout", () => {
  it("renders a 'Refresh site' button", () => {
    render(<AdminLayout>{null}</AdminLayout>);

    expect(screen.getByRole("button", { name: "Refresh site" })).toBeInTheDocument();
  });

  it("no longer links out to a workflow", () => {
    render(<AdminLayout>{null}</AdminLayout>);

    expect(screen.queryByRole("link", { name: /publish snapshot|opens in new tab/i })).toBeNull();
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href") ?? "").not.toMatch(/workflows|github\.com/);
    }
  });

  it("still renders the four existing nav links", () => {
    render(<AdminLayout>{null}</AdminLayout>);

    expect(screen.getByRole("link", { name: "Submissions" })).toHaveAttribute(
      "href",
      "/admin/submissions"
    );
    expect(screen.getByRole("link", { name: "Leads" })).toHaveAttribute(
      "href",
      "/admin/leads"
    );
    expect(screen.getByRole("link", { name: "Facilities" })).toHaveAttribute(
      "href",
      "/admin/facilities"
    );
    expect(screen.getByRole("link", { name: "Contact" })).toHaveAttribute(
      "href",
      "/admin/contact"
    );
  });
});
