import { describe, it, expect, vi, beforeEach } from "vitest";

import { runSubmit, normalizeCandidates, parseCandidatesJson, type RunSubmitOptions } from "./submit-candidates";
import type { Facility } from "../../lib/schema";

const EXISTING_FACILITY: Facility = {
  id: "existing-facility-tx",
  name: "Existing Facility",
  operator: "Acme Corp",
  status: "operational",
  facilityType: "data_center",
  confidence: "confirmed",
  location: { lat: 30.1, lon: -97.1, city: "Austin", state: "TX", precision: "exact" },
  statusHistory: [],
  sources: [
    {
      url: "https://example.com/existing",
      label: "Existing source",
      retrievedAt: "2026-01-01",
      kind: "press",
    },
  ],
  lastUpdated: "2026-01-01",
};

function baseOpts(overrides: Partial<RunSubmitOptions> = {}): RunSubmitOptions {
  return {
    runId: "test-run",
    max: 5,
    dryRun: false,
    baseUrl: "http://localhost:3000",
    discoveredAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

function makeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "new-facility-tx",
    name: "New Facility",
    operator: "Beta Inc",
    status: "proposed",
    facilityType: "data_center",
    confidence: "reported",
    location: { lat: 31.0, lon: -97.5, state: "TX", city: "Round Rock" },
    statusHistory: [],
    sources: [
      { url: "https://example.com/new", label: "New source", retrievedAt: "2026-07-01", kind: "press" },
    ],
    lastUpdated: "2026-07-13",
    ...overrides,
  };
}

function makeFetch(responses: Array<{ ok: boolean; status?: number; body?: unknown }>) {
  let call = 0;
  return vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body ?? {},
      text: async () => JSON.stringify(r.body ?? {}),
    } as unknown as Response;
  });
}

beforeEach(() => {
  process.env.API_ADMIN_TOKEN = "test-token";
});

describe("normalizeCandidates", () => {
  it("normalizes bare facility docs and wrapped { facility, provenance } entries", () => {
    const bare = makeCandidate();
    const wrapped = { facility: makeCandidate({ id: "wrapped-tx" }), provenance: { sources: ["https://x"] } };

    const [a, b] = normalizeCandidates([bare, wrapped]);
    expect(a.doc).toEqual(bare);
    expect(a.provenance).toEqual({});
    expect((b.doc as { id: string }).id).toBe("wrapped-tx");
    expect(b.provenance.sources).toEqual(["https://x"]);
  });
});

describe("runSubmit", () => {
  it("submits a valid new candidate as kind=create", async () => {
    const fetchImpl = makeFetch([{ ok: true, status: 201 }]);
    const candidate = {
      facility: makeCandidate(),
      provenance: { sources: ["https://example.com/new"], discoveredBy: "test" },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.submitted).toBe(1);
    expect(summary.submittedIds).toEqual(["new-facility-tx"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.kind).toBe("create");
    expect(body.targetFacilityId).toBeUndefined();
  });

  it("classifies a candidate whose id already exists as kind=update", async () => {
    const fetchImpl = makeFetch([{ ok: true, status: 200 }]);
    const candidate = {
      facility: makeCandidate({ id: "existing-facility-tx", name: "Existing Facility Updated" }),
      provenance: { sources: ["https://example.com/update"] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.submitted).toBe(1);
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.kind).toBe("update");
    expect(body.targetFacilityId).toBe("existing-facility-tx");
  });

  it("skips a duplicate matched by (name, state, city) even with a new id", async () => {
    const fetchImpl = makeFetch([]);
    const candidate = {
      facility: makeCandidate({
        id: "totally-different-id",
        name: "Existing Facility",
        location: { lat: 30.1, lon: -97.1, state: "TX", city: "Austin" },
      }),
      provenance: { sources: ["https://example.com/dup"] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.skippedDuplicate).toBe(1);
    expect(summary.submitted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips a schema-invalid candidate without POSTing", async () => {
    const fetchImpl = makeFetch([]);
    const candidate = {
      facility: makeCandidate({ location: { lat: 999, lon: -97.5, state: "TX" } }),
      provenance: { sources: ["https://example.com/bad"] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [],
    });

    expect(summary.skippedInvalid).toBe(1);
    expect(summary.submitted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips a candidate with empty sources as invalid without POSTing", async () => {
    const fetchImpl = makeFetch([]);
    const candidate = { facility: makeCandidate(), provenance: { sources: [] } };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [],
    });

    expect(summary.skippedInvalid).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("caps submissions at --max and counts the rest as skippedOverCap", async () => {
    const fetchImpl = makeFetch([{ ok: true }, { ok: true }]);
    const candidates = [
      { facility: makeCandidate({ id: "cap-1" }), provenance: { sources: ["https://x/1"] } },
      { facility: makeCandidate({ id: "cap-2" }), provenance: { sources: ["https://x/2"] } },
      { facility: makeCandidate({ id: "cap-3" }), provenance: { sources: ["https://x/3"] } },
    ];

    const summary = await runSubmit(candidates, baseOpts({ max: 2 }), {
      fetchImpl,
      existingFacilities: [],
    });

    expect(summary.submitted).toBe(2);
    expect(summary.skippedOverCap).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("dry-run produces zero POSTs but a correct summary", async () => {
    const fetchImpl = makeFetch([]);
    const candidate = { facility: makeCandidate(), provenance: { sources: ["https://example.com/new"] } };

    const summary = await runSubmit([candidate], baseOpts({ dryRun: true }), {
      fetchImpl,
      existingFacilities: [],
    });

    expect(summary.submitted).toBe(1);
    expect(summary.submittedIds).toEqual(["new-facility-tx"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("records errors and continues the batch on a non-2xx response", async () => {
    const fetchImpl = makeFetch([{ ok: false, status: 500, body: { error: "boom" } }, { ok: true }]);
    const candidates = [
      { facility: makeCandidate({ id: "err-1" }), provenance: { sources: ["https://x/1"] } },
      { facility: makeCandidate({ id: "err-2" }), provenance: { sources: ["https://x/2"] } },
    ];

    const summary = await runSubmit(candidates, baseOpts(), {
      fetchImpl,
      existingFacilities: [],
    });

    expect(summary.errors).toBe(1);
    expect(summary.submitted).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("parseCandidatesJson", () => {
  it("parses a plain JSON array unchanged", () => {
    const result = parseCandidatesJson('[{"id":"a"},{"id":"b"}]');
    expect(result).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("recovers a candidates array behind a prose preamble", () => {
    const result = parseCandidatesJson(
      'I\'ve verified six facilities. Here is the JSON:\n\n[{"id":"a"}]'
    );
    expect(result).toEqual([{ id: "a" }]);
  });

  it("recovers a candidates array with preamble and trailing prose", () => {
    const result = parseCandidatesJson(
      'Sure, here you go:\n\n[{"id":"a"},{"id":"b"}]\n\nLet me know if you need anything else.'
    );
    expect(result).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("throws on a bare JSON object with no array", () => {
    expect(() => parseCandidatesJson('{"id":"a"}')).toThrow();
  });

  it("throws on unparseable garbage", () => {
    expect(() => parseCandidatesJson("not json at all")).toThrow();
  });
});
