import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExportButtons } from "./export-buttons";
import type { Facility } from "@/lib/schema";

function makeSource() {
  return {
    url: "https://example.com",
    label: "Example Source",
    retrievedAt: "2024-01-01",
    kind: "press" as const,
  };
}

const facility: Facility = {
  id: "alpha-facility",
  name: "Alpha Center",
  operator: "AlphaCorp",
  status: "operational",
  facilityType: "data_center",
  aiClassification: "confirmed",
  confidence: "confirmed",
  location: { lat: 35.0, lon: -90.0, city: "Memphis", state: "TN", precision: "exact" },
  capacityMw: { operational: 150 },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2024-01-01",
};

describe("ExportButtons", () => {
  beforeEach(() => {
    // jsdom does not implement these — stub them for the download path.
    URL.createObjectURL = vi.fn(() => "blob:mock-url");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders both download buttons with accessible labels", () => {
    render(<ExportButtons facilities={[facility]} />);
    expect(
      screen.getByRole("button", { name: /Download 1 facilities as CSV/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Download 1 facilities as JSON/ })
    ).toBeInTheDocument();
  });

  it("wraps the buttons in a labeled group", () => {
    render(<ExportButtons facilities={[facility]} />);
    expect(screen.getByRole("group", { name: "Export facilities" })).toBeInTheDocument();
  });

  it("disables both buttons when facilities is empty", () => {
    render(<ExportButtons facilities={[]} />);
    expect(screen.getByRole("button", { name: /as CSV/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /as JSON/ })).toBeDisabled();
  });

  it("enables both buttons when facilities is non-empty", () => {
    render(<ExportButtons facilities={[facility]} />);
    expect(screen.getByRole("button", { name: /as CSV/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /as JSON/ })).toBeEnabled();
  });

  it("triggers a blob download when the CSV button is clicked", async () => {
    const user = userEvent.setup();
    render(<ExportButtons facilities={[facility]} />);
    await user.click(screen.getByRole("button", { name: /as CSV/ }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it("triggers a blob download when the JSON button is clicked", async () => {
    const user = userEvent.setup();
    render(<ExportButtons facilities={[facility]} />);
    await user.click(screen.getByRole("button", { name: /as JSON/ }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
