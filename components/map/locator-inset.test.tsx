import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { LocatorInset } from "./locator-inset";
import type { Facility } from "@/lib/schema";

/** Minimal facility fixture — only location matters for these tests. */
function at(lon: number, lat: number, id: string): Facility {
  return {
    id,
    name: `Facility ${id}`,
    operator: "SomeOperator",
    status: "operational",
    facilityType: "data_center",
    aiClassification: "confirmed",
    confidence: "confirmed",
    location: { lat, lon, state: "TN", precision: "exact" },
    statusHistory: [],
    sources: [
      {
        url: "https://example.com/source",
        label: "Example",
        retrievedAt: "2024-01",
        kind: "press",
      },
    ],
    lastUpdated: "2024-01",
  };
}

const facilities: Facility[] = [
  at(-90, 35, "a"),
  at(-100, 40, "b"),
  at(-80, 30, "c"),
];

describe("LocatorInset", () => {
  it("renders nothing when facilities is empty", () => {
    const { container } = render(<LocatorInset facilities={[]} map={null} />);
    expect(container.querySelector("[data-locator-inset]")).toBeNull();
  });

  it("renders the container and one dot per facility when map is null", () => {
    const { container } = render(
      <LocatorInset facilities={facilities} map={null} />
    );
    const inset = container.querySelector("[data-locator-inset]");
    expect(inset).not.toBeNull();
    const circles = container.querySelectorAll("circle");
    expect(circles.length).toBe(facilities.length);
    // No map wired up — no viewport rect.
    expect(container.querySelector("rect")).toBeNull();
  });

  it("is aria-hidden (visual-only orientation aid)", () => {
    const { container } = render(
      <LocatorInset facilities={facilities} map={null} />
    );
    const inset = container.querySelector("[data-locator-inset]");
    expect(inset).toHaveAttribute("aria-hidden", "true");
  });

  it("subscribes to map move events and renders a viewport rect", () => {
    const on = vi.fn();
    const off = vi.fn();
    const fakeMap = {
      getBounds: () => ({
        getWest: () => -120,
        getSouth: () => 30,
        getEast: () => -80,
        getNorth: () => 45,
      }),
      on,
      off,
    } as unknown as MapLibreMap;

    const { container, unmount } = render(
      <LocatorInset facilities={facilities} map={fakeMap} />
    );

    expect(on).toHaveBeenCalledWith("move", expect.any(Function));
    expect(container.querySelector("rect")).not.toBeNull();

    unmount();
    expect(off).toHaveBeenCalledWith("move", expect.any(Function));
  });
});
