import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { FooterGate, HeaderGate } from "./footer-gate";

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

  it("renders nothing on an /embed/* route (prefix match, not just /map's exact match)", () => {
    vi.mocked(usePathname).mockReturnValue("/embed/states/texas");

    render(
      <FooterGate>
        <div>Footer content</div>
      </FooterGate>
    );

    expect(screen.queryByText("Footer content")).not.toBeInTheDocument();
  });

  it("renders nothing on the bare /embed route", () => {
    vi.mocked(usePathname).mockReturnValue("/embed");

    render(
      <FooterGate>
        <div>Footer content</div>
      </FooterGate>
    );

    expect(screen.queryByText("Footer content")).not.toBeInTheDocument();
  });

  it("does not treat a route that merely starts with the string 'embed' as an embed route", () => {
    vi.mocked(usePathname).mockReturnValue("/embedded-thing");

    render(
      <FooterGate>
        <div>Footer content</div>
      </FooterGate>
    );

    expect(screen.getByText("Footer content")).toBeInTheDocument();
  });
});

describe("HeaderGate", () => {
  it("renders children on a normal route", () => {
    vi.mocked(usePathname).mockReturnValue("/states");

    render(
      <HeaderGate>
        <div>Header content</div>
      </HeaderGate>
    );

    expect(screen.getByText("Header content")).toBeInTheDocument();
  });

  it("renders children on the /map route — the map shell measures the real header height, so it must stay mounted", () => {
    vi.mocked(usePathname).mockReturnValue("/map");

    render(
      <HeaderGate>
        <div>Header content</div>
      </HeaderGate>
    );

    expect(screen.getByText("Header content")).toBeInTheDocument();
  });

  it("renders nothing on an /embed/* route", () => {
    vi.mocked(usePathname).mockReturnValue("/embed/states/texas");

    render(
      <HeaderGate>
        <div>Header content</div>
      </HeaderGate>
    );

    expect(screen.queryByText("Header content")).not.toBeInTheDocument();
  });
});
