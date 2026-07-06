import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FacilityMarker } from "./facility-marker";
import { buildMarkerLabel } from "@/lib/map";
import type { Facility } from "@/lib/schema";

const fixture: Facility = {
  id: "test-facility",
  name: "Test Facility",
  operator: "Test Operator",
  status: "operational",
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

describe("FacilityMarker", () => {
  it("has accessible name equal to buildMarkerLabel", () => {
    render(
      <FacilityMarker facility={fixture} isSelected={false} onSelect={() => {}} />
    );
    expect(
      screen.getByRole("button", { name: buildMarkerLabel(fixture) })
    ).toBeInTheDocument();
  });

  it("has aria-pressed false when not selected", () => {
    render(
      <FacilityMarker facility={fixture} isSelected={false} onSelect={() => {}} />
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
  });

  it("has aria-pressed true when selected", () => {
    render(
      <FacilityMarker facility={fixture} isSelected={true} onSelect={() => {}} />
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onSelect with the facility when clicked", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <FacilityMarker facility={fixture} isSelected={false} onSelect={onSelect} />
    );
    await user.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith(fixture);
  });

  it("renders the status icon as aria-hidden", () => {
    const { container } = render(
      <FacilityMarker facility={fixture} isSelected={false} onSelect={() => {}} />
    );
    const icon = container.querySelector("[aria-hidden='true']");
    expect(icon).toBeInTheDocument();
  });
});
