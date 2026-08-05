import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { FooterGate } from "./footer-gate";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  usePathname: vi.fn().mockReturnValue("/"),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FooterGate", () => {
  it("renders children on a normal route", () => {
    vi.mocked(usePathname).mockReturnValue("/states");

    render(
      <FooterGate>
        <div>Footer content</div>
      </FooterGate>
    );

    expect(screen.getByText("Footer content")).toBeInTheDocument();
  });

  it("renders nothing on the /map full-bleed route", () => {
    vi.mocked(usePathname).mockReturnValue("/map");

    render(
      <FooterGate>
        <div>Footer content</div>
      </FooterGate>
    );

    expect(screen.queryByText("Footer content")).not.toBeInTheDocument();
  });
});
