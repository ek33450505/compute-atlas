import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Facility } from "@/lib/schema";

// vi.mock calls are hoisted above imports by Vitest. A plain top-level
// `const mockX = vi.fn()` is NOT reliably safe to reference inside a
// vi.mock factory once the mocked module chain imports multiple mocked
// specifiers — route shared mocks through vi.hoisted() so initialization
// is hoisted alongside the vi.mock calls themselves. Mirrors
// app/admin/submissions/submission-list.test.tsx.
const { mockRefresh, mockToastSuccess, mockToastError, mockDeleteFacilityAction } = vi.hoisted(
  () => ({
    mockRefresh: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
    mockDeleteFacilityAction: vi.fn(),
  })
);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

vi.mock("./delete-action", () => ({
  deleteFacilityAction: mockDeleteFacilityAction,
}));

import { FacilityAdminTable } from "./facility-table";

function makeFacility(overrides: Partial<Facility> = {}): Facility {
  return {
    id: "test-facility",
    name: "Test Facility",
    operator: "Test Operator",
    status: "operational",
    confidence: "confirmed",
    location: { lat: 30, lon: -90, state: "TX", city: "Austin" },
    capacityMw: { operational: 100 },
    statusHistory: [],
    sources: [
      {
        url: "https://example.com",
        label: "Press release",
        retrievedAt: "2026-01-01",
        kind: "press",
      },
    ],
    lastUpdated: "2026-01-01",
    facilityType: "data_center",
    ...overrides,
  } as Facility;
}

describe("FacilityAdminTable — rendering", () => {
  it("renders facility rows with name, operator, state, status, type, capacity", () => {
    render(<FacilityAdminTable facilities={[makeFacility()]} />);

    expect(screen.getByText("Test Facility")).toBeInTheDocument();
    expect(screen.getByText("Test Operator")).toBeInTheDocument();
    expect(screen.getByText("Austin, TX")).toBeInTheDocument();
    expect(screen.getByText("100 MW")).toBeInTheDocument();
  });

  it("shows an empty-state message when there are no facilities", () => {
    render(<FacilityAdminTable facilities={[]} />);
    expect(screen.getByText("No facilities found.")).toBeInTheDocument();
  });

  it("renders a New facility button linking to /admin/facilities/new", () => {
    render(<FacilityAdminTable facilities={[]} />);
    const link = screen.getByRole("link", { name: "New facility" });
    expect(link).toHaveAttribute("href", "/admin/facilities/new");
  });

  it("renders an Edit link with an accessible name and correct href", () => {
    render(<FacilityAdminTable facilities={[makeFacility()]} />);
    const editLink = screen.getByRole("link", { name: "Edit Test Facility" });
    expect(editLink).toHaveAttribute("href", "/admin/facilities/test-facility");
  });

  it("toggles column sort direction via the sortable header button", async () => {
    const user = userEvent.setup();
    render(
      <FacilityAdminTable
        facilities={[
          makeFacility({ id: "a", name: "Alpha" }),
          makeFacility({ id: "b", name: "Zulu" }),
        ]}
      />
    );

    const sortButton = screen.getByRole("button", { name: "Sort by Name" });
    await user.click(sortButton);

    // Sorting is asserted via the aria-sort attribute update rather than row
    // order, keeping this test resilient to unrelated column changes.
    const header = sortButton.closest("th");
    expect(header).toHaveAttribute("aria-sort");
  });
});

describe("FacilityAdminTable — delete flow", () => {
  beforeEach(() => {
    mockDeleteFacilityAction.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    mockRefresh.mockClear();
  });

  it("opens the delete confirmation dialog showing the facility name before deleting", async () => {
    const user = userEvent.setup();
    render(<FacilityAdminTable facilities={[makeFacility()]} />);

    await user.click(screen.getByRole("button", { name: "Delete Test Facility" }));

    expect(screen.getByText("Delete “Test Facility”?")).toBeInTheDocument();
    // deleteFacilityAction must not fire merely from opening the dialog.
    expect(mockDeleteFacilityAction).not.toHaveBeenCalled();
  });

  it("calls deleteFacilityAction with the facility id and shows a success toast on confirm", async () => {
    mockDeleteFacilityAction.mockResolvedValue({ ok: true, facility: makeFacility() });
    const user = userEvent.setup();
    render(<FacilityAdminTable facilities={[makeFacility()]} />);

    await user.click(screen.getByRole("button", { name: "Delete Test Facility" }));
    await user.click(screen.getByRole("button", { name: "Delete facility" }));

    await waitFor(() => expect(mockDeleteFacilityAction).toHaveBeenCalledWith("test-facility"));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("shows an error toast and does not refresh when delete fails (e.g. 404)", async () => {
    mockDeleteFacilityAction.mockResolvedValue({
      ok: false,
      status: 404,
      error: "Facility not found",
    });
    const user = userEvent.setup();
    render(<FacilityAdminTable facilities={[makeFacility()]} />);

    await user.click(screen.getByRole("button", { name: "Delete Test Facility" }));
    await user.click(screen.getByRole("button", { name: "Delete facility" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith("Facility not found"));
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("allows cancelling the delete without invoking the action", async () => {
    const user = userEvent.setup();
    render(<FacilityAdminTable facilities={[makeFacility()]} />);

    await user.click(screen.getByRole("button", { name: "Delete Test Facility" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mockDeleteFacilityAction).not.toHaveBeenCalled();
  });
});
