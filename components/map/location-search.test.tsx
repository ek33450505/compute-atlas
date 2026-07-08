import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocationSearch } from "@/components/map/location-search";

// Mock the geocode module so tests never hit the network
vi.mock("@/lib/geocode", () => ({
  geocodeUS: vi.fn(),
}));

import { geocodeUS } from "@/lib/geocode";
const mockGeocode = geocodeUS as ReturnType<typeof vi.fn>;

const RESULT_A = {
  lon: -122.0839,
  lat: 37.3861,
  label: "Mountain View, CA, USA",
  bbox: [-122.2, 37.3, -122.0, 37.5] as [number, number, number, number],
};
const RESULT_B = {
  lon: -73.9857,
  lat: 40.7484,
  label: "New York, NY, USA",
};

beforeEach(() => {
  mockGeocode.mockReset();
});

describe("LocationSearch", () => {
  it("calls geocodeUS with the typed query on submit", async () => {
    mockGeocode.mockResolvedValue([RESULT_A]);
    render(<LocationSearch onSelect={() => {}} />);

    await userEvent.type(screen.getByLabelText("Go to city or ZIP"), "Mountain View");
    await userEvent.click(screen.getByRole("button", { name: "Search location" }));

    expect(mockGeocode).toHaveBeenCalledWith("Mountain View", expect.any(AbortSignal));
  });

  it("calls onSelect with the single result and does not show a dropdown", async () => {
    const onSelect = vi.fn();
    mockGeocode.mockResolvedValue([RESULT_A]);
    render(<LocationSearch onSelect={onSelect} />);

    await userEvent.type(screen.getByLabelText("Go to city or ZIP"), "Mountain View");
    await userEvent.click(screen.getByRole("button", { name: "Search location" }));

    expect(onSelect).toHaveBeenCalledWith(RESULT_A);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("renders a list of buttons when multiple results return, and clicking one calls onSelect", async () => {
    const onSelect = vi.fn();
    mockGeocode.mockResolvedValue([RESULT_A, RESULT_B]);
    render(<LocationSearch onSelect={onSelect} />);

    await userEvent.type(screen.getByLabelText("Go to city or ZIP"), "New York");
    await userEvent.click(screen.getByRole("button", { name: "Search location" }));

    // Dropdown must appear as a plain list (no listbox role)
    const list = await screen.findByRole("list", { name: "Location search results" });
    expect(list).toBeInTheDocument();
    const buttons = within(list).getAllByRole("button");
    expect(buttons).toHaveLength(2);

    // Click the second result
    await userEvent.click(screen.getByText(RESULT_B.label));
    expect(onSelect).toHaveBeenCalledWith(RESULT_B);

    // Dropdown should close after selection
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("shows 'No places found' when geocodeUS returns an empty array", async () => {
    mockGeocode.mockResolvedValue([]);
    render(<LocationSearch onSelect={() => {}} />);

    await userEvent.type(screen.getByLabelText("Go to city or ZIP"), "Xyzzy");
    await userEvent.click(screen.getByRole("button", { name: "Search location" }));

    // The sr-only live region should contain the empty message
    const statusEl = await screen.findByRole("status");
    expect(statusEl).toHaveTextContent("No places found");
  });

  it("shows 'Location search unavailable' when geocodeUS rejects", async () => {
    mockGeocode.mockRejectedValue(new Error("Geocoding failed (429)"));
    render(<LocationSearch onSelect={() => {}} />);

    await userEvent.type(screen.getByLabelText("Go to city or ZIP"), "Denver");
    await userEvent.click(screen.getByRole("button", { name: "Search location" }));

    const statusEl = await screen.findByRole("status");
    expect(statusEl).toHaveTextContent("Location search unavailable");
  });

  it("the form has role=search with accessible name 'Find a place on the map'", () => {
    render(<LocationSearch onSelect={() => {}} />);
    expect(screen.getByRole("search", { name: "Find a place on the map" })).toBeInTheDocument();
  });

  it("the text input is labelled 'Go to city or ZIP'", () => {
    render(<LocationSearch onSelect={() => {}} />);
    expect(screen.getByLabelText("Go to city or ZIP")).toBeInTheDocument();
  });

  it("pressing Escape while results are open closes the list and returns focus to the input", async () => {
    mockGeocode.mockResolvedValue([RESULT_A, RESULT_B]);
    render(<LocationSearch onSelect={() => {}} />);

    // Submit to show results
    const input = screen.getByLabelText("Go to city or ZIP");
    await userEvent.type(input, "New York");
    await userEvent.click(screen.getByRole("button", { name: "Search location" }));

    // Wait for results to appear
    const list = await screen.findByRole("list", { name: "Location search results" });
    expect(list).toBeInTheDocument();

    // Focus the input and press Escape — the root div's onKeyDown handles it
    input.focus();
    await userEvent.keyboard("{Escape}");

    // List must be gone, input must have focus
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Go to city or ZIP")).toHaveFocus();
  });
});
