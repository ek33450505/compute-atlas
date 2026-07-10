import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FacilityPopup } from "./facility-popup";
import type { Facility } from "@/lib/schema";

// next/link renders to <a> — mock to avoid Next.js router-context dependency in jsdom
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const fixture: Facility = {
  id: "test-facility",
  name: "Test Facility",
  operator: "Test Operator",
  status: "operational",
  facilityType: "data_center",
  aiClassification: "confirmed",
  confidence: "confirmed",
  location: { lat: 35.0, lon: -90.0, city: "Memphis", state: "TN" },
  capacityMw: { operational: 100 },
  statusHistory: [],
  sources: [
    {
      url: "https://example.com",
      label: "Example News",
      retrievedAt: "2024-01-01",
      kind: "press",
    },
  ],
  lastUpdated: "2024-01-01",
};

describe("FacilityPopup", () => {
  it("renders facility name", () => {
    render(<FacilityPopup facility={fixture} onClose={() => {}} />);
    expect(screen.getByText("Test Facility")).toBeInTheDocument();
  });

  it("renders facility operator", () => {
    render(<FacilityPopup facility={fixture} onClose={() => {}} />);
    expect(screen.getByText("Test Operator")).toBeInTheDocument();
  });

  it("renders status label", () => {
    render(<FacilityPopup facility={fixture} onClose={() => {}} />);
    expect(screen.getByText("Operational")).toBeInTheDocument();
  });

  it("renders capacity when present", () => {
    render(<FacilityPopup facility={fixture} onClose={() => {}} />);
    expect(screen.getByText("100 MW operational")).toBeInTheDocument();
  });

  it("does not render capacity when absent", () => {
    const noCapacity = { ...fixture, capacityMw: undefined };
    render(<FacilityPopup facility={noCapacity} onClose={() => {}} />);
    expect(screen.queryByText(/MW operational/)).not.toBeInTheDocument();
  });

  it("source link has rel noreferrer noopener and accessible name with 'opens in new tab'", () => {
    render(<FacilityPopup facility={fixture} onClose={() => {}} />);
    const sourceLink = screen.getByRole("link", { name: /opens in new tab/i });
    expect(sourceLink).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("pressing Escape calls onClose", () => {
    const onClose = vi.fn();
    render(<FacilityPopup facility={fixture} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
