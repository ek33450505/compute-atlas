import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Facility } from "@/lib/schema";

// vi.mock calls are hoisted above imports by Vitest. A plain top-level
// `const mockX = vi.fn()` is NOT reliably safe to reference inside a
// vi.mock factory once the mocked module chain imports multiple mocked
// specifiers — route shared mocks through vi.hoisted() so initialization
// is hoisted alongside the vi.mock calls themselves. Mirrors
// app/admin/facilities/facility-table.test.tsx.
const { mockPush, mockToastSuccess, mockToastError, mockCreateFacilityAction, mockUpdateFacilityAction } =
  vi.hoisted(() => ({
    mockPush: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
    mockCreateFacilityAction: vi.fn(),
    mockUpdateFacilityAction: vi.fn(),
  }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: mockToastSuccess,
    error: mockToastError,
  },
}));

vi.mock("./facility-form-actions", () => ({
  createFacilityAction: mockCreateFacilityAction,
  updateFacilityAction: mockUpdateFacilityAction,
}));

import {
  FacilityForm,
  emptyFacilityFormState,
  facilityToFormState,
  buildFacilityPayload,
} from "./facility-form";

function makeFacility(overrides: Partial<Facility> = {}): Facility {
  return {
    id: "test-facility",
    name: "Test Facility",
    operator: "Test Operator",
    status: "operational",
    confidence: "confirmed",
    location: { lat: 30, lon: -90, state: "TX", city: "Austin", precision: "exact" },
    capacityMw: { operational: 100, planned: 200 },
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

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

describe("emptyFacilityFormState", () => {
  it("produces empty defaults for every extension-point field the schema requires", () => {
    const state = emptyFacilityFormState();

    expect(state.statusHistory).toEqual([]);
    expect(state.sources).toEqual([]);
    expect(state.subsidies).toEqual([]);
    expect(state.energy).toEqual({});
    expect(state.water).toEqual({});
    expect(state.jobs).toEqual({});
    expect(state.community).toEqual({});
    expect(state.location.multiSite.enabled).toBe(false);
    expect(state.location.precision).toBe("exact");
  });
});

describe("facilityToFormState", () => {
  it("round-trips scalar, location, and capacityMw fields from a loaded facility", () => {
    const facility = makeFacility();
    const state = facilityToFormState(facility);

    expect(state.id).toBe("test-facility");
    expect(state.name).toBe("Test Facility");
    expect(state.status).toBe("operational");
    expect(state.confidence).toBe("confirmed");
    expect(state.location.lat).toBe("30");
    expect(state.location.lon).toBe("-90");
    expect(state.location.state).toBe("TX");
    expect(state.capacityMw.operational).toBe("100");
    expect(state.capacityMw.planned).toBe("200");
  });

  it("preserves not-yet-UI'd array/object fields so a later sub-unit's UI has real data", () => {
    const facility = makeFacility({
      sources: [
        { url: "https://a.com", label: "A", retrievedAt: "2026-01-01", kind: "press" },
        { url: "https://b.com", label: "B", retrievedAt: "2026-01-02", kind: "filing" },
      ],
    });
    const state = facilityToFormState(facility);

    expect(state.sources).toHaveLength(2);
    expect(state.sources[0].url).toBe("https://a.com");
  });

  it("populates multiSite state when the facility has a multiSite location", () => {
    const facility = makeFacility({
      location: {
        lat: 30,
        lon: -90,
        state: "TX",
        precision: "representative_multi_site",
        multiSite: { states: ["TX", "OK"], siteCountNote: "3 sites" },
      },
    });
    const state = facilityToFormState(facility);

    expect(state.location.multiSite.enabled).toBe(true);
    expect(state.location.multiSite.states).toBe("TX, OK");
    expect(state.location.multiSite.siteCountNote).toBe("3 sites");
  });
});

describe("buildFacilityPayload — shallow-merge safety", () => {
  it("always submits location as a complete object, never a partial one", () => {
    const state = facilityToFormState(
      makeFacility({
        location: { lat: 30, lon: -90, state: "TX", city: "Austin", precision: "exact" },
      })
    );
    const payload = buildFacilityPayload(state);

    const location = payload.location as Record<string, unknown>;
    expect(location.lat).toBe(30);
    expect(location.lon).toBe(-90);
    expect(location.state).toBe("TX");
    expect(location.city).toBe("Austin");
    expect(location.precision).toBe("exact");
  });

  it("always submits capacityMw as a complete object even when only one sub-field is set", () => {
    const state = emptyFacilityFormState();
    state.capacityMw.operational = "150";
    const payload = buildFacilityPayload(state);

    expect(payload.capacityMw).toEqual({ operational: 150 });
  });

  it("submits energy/water/jobs/community as whole objects (empty {} when untouched)", () => {
    const state = emptyFacilityFormState();
    const payload = buildFacilityPayload(state);

    expect(payload.energy).toEqual({});
    expect(payload.water).toEqual({});
    expect(payload.jobs).toEqual({});
    expect(payload.community).toEqual({});
  });

  it("carries sources/statusHistory/subsidies through unchanged from state", () => {
    const facility = makeFacility();
    const state = facilityToFormState(facility);
    const payload = buildFacilityPayload(state);

    expect(payload.sources).toEqual(facility.sources);
    expect(payload.statusHistory).toEqual(facility.statusHistory);
  });

  it("omits optional scalar fields entirely when blank rather than sending empty strings", () => {
    const state = emptyFacilityFormState();
    state.id = "new-fac";
    state.name = "New Facility";
    state.operator = "Op";
    state.lastUpdated = "2026-01-01";
    const payload = buildFacilityPayload(state);

    expect(payload.poweredBy).toBeUndefined();
    expect(payload.announcedDate).toBeUndefined();
    expect(payload.notes).toBeUndefined();
    expect(payload.investmentUsd).toBeUndefined();
    expect(payload.landAcres).toBeUndefined();
  });

  it("builds the correct type-conditional branch for each facilityType", () => {
    const dataCenterState = emptyFacilityFormState();
    dataCenterState.facilityType = "data_center";
    const dcPayload = buildFacilityPayload(dataCenterState);
    expect(dcPayload.environmental).toEqual({});
    expect(dcPayload.mining).toBeUndefined();
    expect(dcPayload.generation).toBeUndefined();

    const cryptoState = emptyFacilityFormState();
    cryptoState.facilityType = "crypto_mining";
    const cryptoPayload = buildFacilityPayload(cryptoState);
    expect(cryptoPayload.mining).toEqual({});
    expect(cryptoPayload.environmental).toEqual({});
    expect(cryptoPayload.generation).toBeUndefined();

    const generationState = emptyFacilityFormState();
    generationState.facilityType = "power_generation";
    const generationPayload = buildFacilityPayload(generationState);
    expect(generationPayload.generation).toEqual({});
    expect(generationPayload.mining).toBeUndefined();
    expect(generationPayload.environmental).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Rendered behavior
// ---------------------------------------------------------------------------

describe("FacilityForm — create mode", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    mockCreateFacilityAction.mockClear();
    mockUpdateFacilityAction.mockClear();
  });

  it("renders the facility ID field only in create mode", () => {
    render(<FacilityForm mode="create" initialState={emptyFacilityFormState()} />);
    expect(screen.getByLabelText(/facility id/i)).toBeInTheDocument();
  });

  it("resets the type-conditional state slice when facilityType changes", async () => {
    const user = userEvent.setup();
    const state = emptyFacilityFormState();
    state.facilityType = "crypto_mining";
    state.mining = { hashRateThPerS: 500 };

    mockCreateFacilityAction.mockResolvedValue({
      ok: true,
      facility: { id: "x", name: "x" },
    });

    render(<FacilityForm mode="create" initialState={state} />);

    // Switch facilityType via the select trigger, then submit — the
    // stale `mining` data must not appear in the submitted payload.
    // The Base UI Select popup is portaled and opens asynchronously, so
    // the option must be awaited with `findByRole` (which retries) rather
    // than a synchronous `getByRole` — a synchronous query flakes under
    // full-suite timing (passes in isolation, races when run alongside the
    // other 65 test files).
    await user.click(screen.getByLabelText(/facility type/i));
    const dataCenterOption = await screen.findByRole("option", { name: /data center/i });
    await user.click(dataCenterOption);

    await user.type(screen.getByLabelText(/^name$/i), "New DC");
    await user.type(screen.getByLabelText(/^operator$/i), "New Op");
    await user.type(screen.getByLabelText(/facility id/i), "new-dc");
    await user.type(screen.getByLabelText(/latitude/i), "30");
    await user.type(screen.getByLabelText(/longitude/i), "-90");
    await user.type(screen.getByLabelText(/^state \(2-letter\)$/i), "TX");
    await user.type(screen.getByLabelText(/last updated/i), "2026-01-01");

    await user.click(screen.getByRole("button", { name: /create facility/i }));

    await waitFor(() => expect(mockCreateFacilityAction).toHaveBeenCalled());
    const submittedPayload = mockCreateFacilityAction.mock.calls[0][0];
    expect(submittedPayload.mining).toBeUndefined();
    expect(submittedPayload.environmental).toEqual({});
  });

  /** Fills every HTML-`required` field on the create form so native browser
   * validation doesn't block the submit handler from running. */
  async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText(/facility id/i), "new-dc");
    await user.type(screen.getByLabelText(/^name$/i), "New DC");
    await user.type(screen.getByLabelText(/^operator$/i), "New Op");
    await user.type(screen.getByLabelText(/latitude/i), "30");
    await user.type(screen.getByLabelText(/longitude/i), "-90");
    await user.type(screen.getByLabelText(/^state \(2-letter\)$/i), "TX");
    await user.type(screen.getByLabelText(/last updated/i), "2026-01-01");
  }

  it("surfaces field-level errors from a 400 response's issues array", async () => {
    const user = userEvent.setup();
    mockCreateFacilityAction.mockResolvedValue({
      ok: false,
      status: 400,
      error: "Invalid facility",
      issues: [{ path: ["name"], message: "Name is required" }],
    });

    render(<FacilityForm mode="create" initialState={emptyFacilityFormState()} />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: /create facility/i }));

    await waitFor(() =>
      expect(screen.getByText("Name is required")).toBeInTheDocument()
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("redirects to /admin/facilities and toasts on success", async () => {
    const user = userEvent.setup();
    mockCreateFacilityAction.mockResolvedValue({
      ok: true,
      facility: { id: "new-dc", name: "New DC" },
    });

    render(<FacilityForm mode="create" initialState={emptyFacilityFormState()} />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: /create facility/i }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/admin/facilities"));
    expect(mockToastSuccess).toHaveBeenCalled();
  });
});

describe("FacilityForm — edit mode", () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockToastSuccess.mockClear();
    mockUpdateFacilityAction.mockClear();
  });

  it("does not render the facility ID input (id is immutable after create)", () => {
    const state = facilityToFormState(makeFacility());
    render(<FacilityForm mode="edit" initialState={state} />);
    expect(screen.queryByLabelText(/facility id/i)).not.toBeInTheDocument();
  });

  it("calls updateFacilityAction with the id and a shape-complete payload", async () => {
    const user = userEvent.setup();
    mockUpdateFacilityAction.mockResolvedValue({
      ok: true,
      facility: { id: "test-facility", name: "Test Facility" },
    });

    const state = facilityToFormState(makeFacility());
    render(<FacilityForm mode="edit" initialState={state} />);

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mockUpdateFacilityAction).toHaveBeenCalled());
    const [id, payload] = mockUpdateFacilityAction.mock.calls[0];
    expect(id).toBe("test-facility");
    expect(payload.location).toEqual({
      lat: 30,
      lon: -90,
      state: "TX",
      city: "Austin",
      precision: "exact",
    });
  });
});
