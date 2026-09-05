import { vi, describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockLogout } = vi.hoisted(() => ({
  mockLogout: vi.fn(),
}));

vi.mock("@/app/admin/login/actions", () => ({
  logout: mockLogout,
}));

import AdminLayout from "./layout";

describe("AdminLayout", () => {
  it("renders a 'Publish snapshot' link to the neon-sync workflow", () => {
    render(<AdminLayout>{null}</AdminLayout>);

    const link = screen.getByRole("link", { name: /opens in new tab/i });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/ek33450505/compute-atlas/actions/workflows/neon-sync.yml"
    );
  });

  it("opens the publish snapshot link in a new tab safely", () => {
    render(<AdminLayout>{null}</AdminLayout>);

    const link = screen.getByRole("link", { name: /opens in new tab/i });
    expect(link).toHaveAttribute("target", "_blank");
    const rel = link.getAttribute("rel") ?? "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });

  it("gives the publish snapshot link an accessible name mentioning it opens in a new tab", () => {
    render(<AdminLayout>{null}</AdminLayout>);

    expect(
      screen.getByRole("link", { name: /publish snapshot.*opens in new tab/i })
    ).toBeInTheDocument();
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
