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
  location: { lat: 35.0, lon: -90.0, city: "Memphis", state: "TN", precision: "exact" },
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

  it("renders a siting-distance cue for a facility with siting context", () => {
    // xai-colossus-memphis-tn has a real entry in data/siting-context.json:
    // nearestWater "Nonconnah Creek" (0.7 mi) + nearestTransmission 500 kV (4.5 mi).
    const withContext = { ...fixture, id: "xai-colossus-memphis-tn" };
    render(<FacilityPopup facility={withContext} onClose={() => {}} />);
    expect(screen.getByText(/Nonconnah Creek/)).toBeInTheDocument();
    expect(screen.getByText(/0\.7 mi/)).toBeInTheDocument();
  });

  it("renders no siting cue for a facility without siting context", () => {
    render(<FacilityPopup facility={fixture} onClose={() => {}} />);
    expect(screen.queryByText(/mi —/)).not.toBeInTheDocument();
  });

  it("close button meets the 24px WCAG 2.5.8 floor via explicit h-7 w-7 (28px) sizing", () => {
    render(<FacilityPopup facility={fixture} onClose={() => {}} />);
    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton.className).toContain("h-7");
    expect(closeButton.className).toContain("w-7");
  });

  it("footer links are padded to a 24px+ tall target (not exempt as inline prose links)", () => {
    render(<FacilityPopup facility={fixture} onClose={() => {}} />);
    expect(screen.getByRole("link", { name: "View details →" }).className).toContain(
      "py-1.5"
    );
    expect(screen.getByRole("link", { name: /opens in new tab/i }).className).toContain(
      "py-1.5"
    );
  });

  it("caps the card's max-width responsively so it can't overflow a narrow viewport", () => {
    render(<FacilityPopup facility={fixture} onClose={() => {}} />);
    const headerRow = screen.getByText("Test Facility").closest("div")!;
    const card = headerRow.parentElement!;
    expect(card.className).toContain("max-w-[min(280px,calc(100vw-5rem))]");
  });

  describe("scrollable body — measured max-height", () => {
    // Same pattern as facility-map.test.tsx's "Tools Panel — measured-top
    // scroll cap" tests: getBoundingClientRect and window.innerHeight are
    // mocked so the resulting inline maxHeight is deterministic.
    it("caps the body to the measured space below it (window fallback when not nested in a map)", () => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        top: 200,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => {},
      } as DOMRect);
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(390);

      render(<FacilityPopup facility={fixture} onClose={() => {}} />);
      const body = screen.getByText("Test Operator").parentElement as HTMLElement;
      // Math.max(0, 390 - 200 - 20) = 170
      expect(body.style.maxHeight).toBe("170px");

      vi.restoreAllMocks();
    });

    it("clamps the cap to 0 rather than exceeding the real available space", () => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        top: 500,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => {},
      } as DOMRect);
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(390);

      render(<FacilityPopup facility={fixture} onClose={() => {}} />);
      const body = screen.getByText("Test Operator").parentElement as HTMLElement;
      // Math.max(0, 390 - 500 - 20) = 0
      expect(body.style.maxHeight).toBe("0px");

      vi.restoreAllMocks();
    });

    it("bounds the cap against the map's own container edge when nested inside one, not the window", () => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        top: 300,
        bottom: 350,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => {},
      } as DOMRect);
      // Deliberately far off from the expected 30px result, to prove the
      // map container's own bottom edge is used instead of window height.
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);

      render(
        <div className="maplibregl-map">
          <FacilityPopup facility={fixture} onClose={() => {}} />
        </div>
      );
      const body = screen.getByText("Test Operator").parentElement as HTMLElement;
      // Math.max(0, 350 - 300 - 20) = 30
      expect(body.style.maxHeight).toBe("30px");

      vi.restoreAllMocks();
    });
  });
});
