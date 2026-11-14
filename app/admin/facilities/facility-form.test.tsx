import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { mergeFacilityPatch } from "@/lib/facility-patch";
import { facilitySchema, type Facility } from "@/lib/schema";

// vi.mock calls are hoisted above imports by Vitest. A plain top-level
// `const mockX = vi.fn()` is NOT reliably safe to reference inside a
// vi.mock factory once the mocked module chain imports multiple mocked
// specifiers — route shared mocks through vi.hoisted() so initialization
// is hoisted alongside the vi.mock calls themselves. Mirrors
// app/admin/facilities/facility-table.test.tsx.
const {
  mockPush,
  mockToastSuccess,
  mockToastWarning,
  mockToastError,
  mockCreateFacilityAction,
  mockUpdateFacilityAction,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastWarning: vi.fn(),
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
    warning: mockToastWarning,
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
    expect(state.location.precision).toBe("approximate");
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
  // Pins the MERGED semantics: the form sends no curated keys, and
  // mergeFacilityPatch carries them only while what they describe is unchanged.
  const stored = () =>
    makeFacility({
      capacityMw: { operational: 100, planned: 200, basis: "it", itPlanned: 150, itOperational: 80 },
      energy: { source: "grid", utility: "Duke", utilityEiaId: { id: 5416, sourceIndex: 0 } },
      ids: { eiaPlantId: { id: 123, sourceIndex: 0 } },
      parties: { ownerEntity: [{ name: "Acme LLC", sourceIndex: 0 }] },
      construction: { expectedStart: { date: "2026", sourceIndex: 0 } },
    });
  const save = (existing: Facility, edit: (s: ReturnType<typeof facilityToFormState>) => void) => {
    const state = facilityToFormState(existing);
    edit(state);
    const merged = mergeFacilityPatch(existing, buildFacilityPayload(state));
    expect(facilitySchema.safeParse(merged).success).toBe(true);
    return merged;
  };

  it("keeps basis and the IT figures, plus ids/parties/construction and utilityEiaId, when nothing changes", () => {
    const existing = stored();
    const merged = save(existing, () => {});
    expect(merged.capacityMw).toEqual(existing.capacityMw);
    expect(merged.energy).toEqual(existing.energy);
    expect(merged.ids).toEqual(existing.ids);
    expect(merged.parties).toEqual(existing.parties);
    expect(merged.construction).toEqual(existing.construction);
  });

  it("drops basis but keeps the IT figures when planned MW changes", () => {
    const merged = save(stored(), (s) => {
      s.capacityMw.planned = "250";
    });
    expect(merged.capacityMw).toEqual({
      planned: 250,
      operational: 100,
      itPlanned: 150,
      itOperational: 80,
    });
  });

  it("drops basis, itPlanned and itOperational on a switch to power_generation", () => {
    const merged = save(stored(), (s) => {
      s.facilityType = "power_generation";
      s.generation = { technology: "solar" };
    });
    expect(merged.capacityMw).toEqual({ planned: 200, operational: 100 });
  });

  it("drops utilityEiaId when the utility changes", () => {
    const merged = save(stored(), (s) => {
      s.energy = { ...s.energy, utility: "Dominion" };
    });
    expect((merged.energy as Record<string, unknown>).utilityEiaId).toBeUndefined();
    expect((merged.energy as Record<string, unknown>).utility).toBe("Dominion");
  });

  it("keeps utilityEiaId when the utility is unchanged but another energy field is edited", () => {
    const merged = save(stored(), (s) => {
      s.energy = { ...s.energy, notes: "edited" };
    });
    expect((merged.energy as Record<string, unknown>).utilityEiaId).toEqual({ id: 5416, sourceIndex: 0 });
  });

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

  it("submits a location that replaces the stored one under the patch merge, so a blanked city and county are cleared", () => {
    const stored = makeFacility({
      location: { lat: 30, lon: -90, state: "TX", city: "Austin", county: "Travis", precision: "exact" },
    });
    const state = facilityToFormState(stored);
    state.location.city = "";
    state.location.county = "";

    const merged = mergeFacilityPatch(stored, buildFacilityPayload(state));

    expect(merged.location).toEqual({ lat: 30, lon: -90, state: "TX", precision: "exact" });
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
    mockToastWarning.mockClear();
    mockToastError.mockClear();
    mockCreateFacilityAction.mockClear();
    mockUpdateFacilityAction.mockClear();
  });

  it("renders the facility ID field only in create mode", () => {
    render(<FacilityForm mode="create" initialState={emptyFacilityFormState()} />);
    expect(screen.getByLabelText(/facility id/i)).toBeInTheDocument();
  });

  it("resets the type-conditional state slice when facilityType changes", async () => {
    // `delay: null` disables user-event's per-keystroke `setTimeout` round-trip
    // (see fillRequiredFields below) — with the default `delay: 0`, each of the
    // ~35 characters typed by this test still schedules a real macrotask via
    // `setTimeout(resolve, 0)`, and under full-suite CPU contention those add up
    // to multiple seconds, blowing the default 5000ms testTimeout with no
    // functional failure (flaky under load, passes reliably in isolation).
    const user = userEvent.setup({ delay: null });
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
    const user = userEvent.setup({ delay: null });
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
    const user = userEvent.setup({ delay: null });
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

  // Regression coverage for lib/facility-write.ts's recordFacilityHistory:
  // the facility write can succeed while its facility_history audit row
  // fails to insert. That must still redirect (the write itself succeeded)
  // but warn instead of silently celebrating a clean success.
  it("shows a warning toast (not success) when created but the audit row failed to record", async () => {
    const user = userEvent.setup({ delay: null });
    mockCreateFacilityAction.mockResolvedValue({
      ok: true,
      facility: { id: "new-dc", name: "New DC" },
      historyRecorded: false,
    });

    render(<FacilityForm mode="create" initialState={emptyFacilityFormState()} />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: /create facility/i }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/admin/facilities"));
    expect(mockToastWarning).toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
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
    const user = userEvent.setup({ delay: null });
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

describe("FacilityForm — source editor keeps citations in step", () => {
  beforeEach(() => {
    mockUpdateFacilityAction.mockReset();
  });

  /**
   * Opens the status-history row's source picker (the first "Source…" combobox
   * in the form; the closed trigger renders no label) and returns the selected
   * option's text.
   */
  async function selectedStatusHistorySource(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getAllByRole("combobox", { name: /^source/i })[0]);
    const selected = (await screen.findAllByRole("option")).find(
      (o) => o.getAttribute("aria-selected") === "true"
    );
    await user.keyboard("{Escape}");
    return selected?.textContent;
  }

  function threeSourceFacility(citedIndex: number) {
    const src = (label: string) => ({
      url: `https://example.com/${label}`,
      label,
      retrievedAt: "2026-01-01",
      kind: "press" as const,
    });
    return makeFacility({
      sources: [src("Source A"), src("Source B"), src("Source C")],
      statusHistory: [{ status: "proposed", date: "2026-01-01", sourceIndex: citedIndex }],
    });
  }

  it("keeps a status-history picker on the same source after a move", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <FacilityForm mode="edit" initialState={facilityToFormState(threeSourceFacility(2))} />
    );
    expect(await selectedStatusHistorySource(user)).toMatch(/^3\..*Source C/);

    await user.click(screen.getByRole("button", { name: /move source 3 up/i }));

    expect(screen.getByDisplayValue("Source C")).toHaveAttribute("name", "sources.1.label");
    expect(await selectedStatusHistorySource(user)).toMatch(/^2\..*Source C/);
  });

  it("blocks removing a cited source, names the citation and keeps the row", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <FacilityForm mode="edit" initialState={facilityToFormState(threeSourceFacility(0))} />
    );

    const remove = screen.getByRole("button", { name: /remove source 1/i });
    await user.click(remove);

    const row = screen.getByRole("group", { name: /^source 1$/i });
    expect(within(row).getByRole("status")).toHaveTextContent(
      "Cited by status history entry 1. Change those citations first."
    );
    expect(screen.getByDisplayValue("Source A")).toBeInTheDocument();
    expect(document.activeElement).toBe(remove);
  });

  it("shifts a later citation to the same source when an uncited source is removed", async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <FacilityForm mode="edit" initialState={facilityToFormState(threeSourceFacility(2))} />
    );

    await user.click(screen.getByRole("button", { name: /remove source 1/i }));

    expect(screen.queryByDisplayValue("Source A")).not.toBeInTheDocument();
    expect(await selectedStatusHistorySource(user)).toMatch(/^2\..*Source C/);
  });

  it("sends sourceOrigins reflecting a move plus an add on submit", async () => {
    const user = userEvent.setup({ delay: null });
    mockUpdateFacilityAction.mockResolvedValue({
      ok: true,
      facility: { id: "test-facility", name: "Test Facility" },
    });
    render(
      <FacilityForm mode="edit" initialState={facilityToFormState(threeSourceFacility(2))} />
    );

    await user.click(screen.getByRole("button", { name: /move source 3 up/i }));
    await user.click(screen.getByRole("button", { name: /add source/i }));
    // The new row's required fields must be filled or native validation blocks submit.
    await user.type(document.getElementById("sources.3.url") as HTMLElement, "https://example.com/new");
    await user.type(document.getElementById("sources.3.label") as HTMLElement, "Source D");
    await user.type(document.getElementById("sources.3.retrievedAt") as HTMLElement, "2026-02-02");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mockUpdateFacilityAction).toHaveBeenCalled());
    const [, payload, origins] = mockUpdateFacilityAction.mock.calls[0];
    expect(origins).toEqual([0, 2, 1, null]);
    expect(payload.statusHistory[0].sourceIndex).toBe(1);
  });

  it("lists carried citations the server could not remap, in plain words", async () => {
    const user = userEvent.setup({ delay: null });
    mockUpdateFacilityAction.mockResolvedValue({
      ok: false,
      error: "Some citations point at a removed source.",
      issues: [
        { path: ["stakeholders", 1, "sourceIndex"], message: "removed" },
        { path: ["construction", "disturbedAcres", "sourceIndex"], message: "removed" },
      ],
    });
    render(
      <FacilityForm mode="edit" initialState={facilityToFormState(threeSourceFacility(2))} />
    );

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(
      await screen.findByText(
        /These citations point at a source you removed or moved: stakeholders entry 2, construction disturbed acres\. Reload the page to discard all unsaved changes, or ask the maintainer to edit those fields\./
      )
    ).toBeInTheDocument();
  });
});
