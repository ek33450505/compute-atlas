import { describe, it, expect, vi, beforeEach } from "vitest";

import { runSubmit, normalizeCandidates, parseCandidatesJson, type RunSubmitOptions } from "./submit-candidates";
import type { Facility } from "../../lib/schema";
import type { VerifyClaim, VerificationResult } from "./verify-source";

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

/**
 * Builds a stubbed `verifyImpl` for the Task 6 verification-gate seams.
 * `impl` computes the verdict/reason synchronously per (url, claim) call —
 * kept as a raw function rather than a fixed map so a single test can branch
 * on the URL (e.g. "one verified among several").
 */
function makeVerifyImpl(impl: (url: string, claim: VerifyClaim) => Partial<VerificationResult> & { verdict: VerificationResult["verdict"] }) {
  return vi.fn(async (url: string, claim: VerifyClaim): Promise<VerificationResult> => {
    const result = impl(url, claim);
    return { reason: `stub reason for ${url}`, sourceUrl: url, ...result };
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
    expect(a.type).toBe("facility");
    expect(b.type).toBe("facility");
    if (a.type === "facility" && b.type === "facility") {
      expect(a.doc).toEqual(bare);
      expect(a.provenance).toEqual({});
      expect((b.doc as { id: string }).id).toBe("wrapped-tx");
      expect(b.provenance.sources).toEqual(["https://x"]);
    }
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

describe("runSubmit — verification gate (facility seam)", () => {
  it("rejects a candidate when zero sources verify, without consuming --max cap budget for a later candidate", async () => {
    const fetchImpl = makeFetch([{ ok: true }]);
    const verifyImpl = makeVerifyImpl((url) => ({
      verdict: url.includes("fabricated") ? "rejected" : "verified",
    }));
    const candidates = [
      { facility: makeCandidate({ id: "reject-1" }), provenance: { sources: ["https://example.com/fabricated"] } },
      { facility: makeCandidate({ id: "verified-2" }), provenance: { sources: ["https://example.com/real"] } },
    ];

    const summary = await runSubmit(candidates, baseOpts({ max: 1 }), {
      fetchImpl,
      existingFacilities: [],
      verifyImpl,
    });

    expect(summary.skippedUnverified).toBe(1);
    expect(summary.submitted).toBe(1);
    expect(summary.submittedIds).toEqual(["verified-2"]);
    expect(summary.skippedOverCap).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("produces a rejectionDetail (and skip-unverified log line) distinguishing an unreadable source from one that was read and rejected, never a generic 'could not be verified' message", async () => {
    const fetchImpl = makeFetch([]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const verifyImpl = makeVerifyImpl((url) =>
      url.endsWith("/unreadable")
        ? {
            verdict: "rejected",
            reason: "original fetch failed (bad_content_type (http 200)); Wayback snapshot check — not_mentioned",
            transportFailure: { reason: "bad_content_type", httpStatus: 200 },
          }
        : { verdict: "rejected", reason: "quote fragment not found verbatim on the page" }
    );
    const candidate = {
      facility: makeCandidate({ id: "all-rejected-1" }),
      provenance: { sources: ["https://example.com/unreadable", "https://example.com/read-but-rejected"] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [],
      verifyImpl,
    });

    expect(summary.skippedUnverified).toBe(1);
    expect(summary.submitted).toBe(0);
    const skipLine = logSpy.mock.calls.map(([msg]) => msg).find((msg) => typeof msg === "string" && msg.startsWith("skip unverified:"));
    expect(skipLine).toBeDefined();
    // The transportFailure-carrying source reads as unreadable...
    expect(skipLine).toContain("could not be read");
    expect(skipLine).toContain("bad_content_type");
    // ...while the genuinely-read-and-rejected source keeps its OWN reason,
    // not lumped into the same "could not be read" bucket.
    expect(skipLine).toContain("quote fragment not found verbatim on the page");
    // The old blanket wording erased this distinction entirely — it must be gone.
    expect(skipLine).not.toContain("no cited source could be mechanically verified");
    logSpy.mockRestore();
  });

  it("submits when at least one of several sources verifies, even if others reject", async () => {
    const fetchImpl = makeFetch([{ ok: true }]);
    const verifyImpl = makeVerifyImpl((url) => ({
      verdict: url.endsWith("/good") ? "verified" : "rejected",
    }));
    const candidate = {
      facility: makeCandidate({ id: "multi-source-1" }),
      provenance: { sources: ["https://example.com/bad", "https://example.com/good"] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [],
      verifyImpl,
    });

    expect(summary.submitted).toBe(1);
    expect(summary.skippedUnverified).toBe(0);
    expect(verifyImpl).toHaveBeenCalledTimes(2);
  });

  it("submits a candidate whose sources are unverified-but-escalated, surfacing the escalation in the provenance note", async () => {
    const fetchImpl = makeFetch([{ ok: true }]);
    const verifyImpl = makeVerifyImpl(() => ({ verdict: "escalate", reason: "too_large" }));
    const candidate = {
      facility: makeCandidate({ id: "escalate-1" }),
      provenance: { sources: ["https://example.com/escalate"] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [],
      verifyImpl,
    });

    expect(summary.submitted).toBe(1);
    expect(summary.skippedUnverified).toBe(0);
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.provenance.note).toMatch(/escalat/i);
    expect(body.provenance.note).toContain("https://example.com/escalate");
  });

  // verify-source.ts's escalate/unavailable verdicts are expected to fire far
  // more often once page-truncation (escalate) and Ollama/Wayback timeouts
  // (unavailable) land there (Ed, approved) — this gate's handling of both
  // is verdict-driven, never keyed on the specific `reason` string, so it
  // does not need to change when that lands. These two tests pin that with a
  // DIFFERENT reason string / a MIXED result set than the tests above, to
  // demonstrate the behavior generalizes rather than just happening to match
  // one hardcoded example.
  it("survives on escalate even when mixed with rejected sources, and the note reports only the escalated ones", async () => {
    const fetchImpl = makeFetch([{ ok: true }]);
    const verifyImpl = makeVerifyImpl((url) => ({
      verdict: url.endsWith("/rejected") ? "rejected" : "escalate",
      reason: url.endsWith("/rejected") ? "quote not found on page" : "page truncated by context window; model said not_mentioned",
    }));
    const candidate = {
      facility: makeCandidate({ id: "mixed-escalate-1" }),
      provenance: { sources: ["https://example.com/rejected", "https://example.com/truncated"] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [],
      verifyImpl,
    });

    expect(summary.submitted).toBe(1);
    expect(summary.skippedUnverified).toBe(0);
    expect(verifyImpl).toHaveBeenCalledTimes(2);
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.provenance.note).toContain("https://example.com/truncated");
    expect(body.provenance.note).not.toContain("https://example.com/rejected");
  });

  it("skips the verification gate entirely in dry-run mode", async () => {
    const fetchImpl = makeFetch([]);
    const verifyImpl = makeVerifyImpl(() => ({ verdict: "rejected", reason: "should never be called" }));
    const candidate = { facility: makeCandidate(), provenance: { sources: ["https://example.com/new"] } };

    const summary = await runSubmit([candidate], baseOpts({ dryRun: true }), {
      fetchImpl,
      existingFacilities: [],
      verifyImpl,
    });

    expect(summary.submitted).toBe(1);
    expect(verifyImpl).not.toHaveBeenCalled();
  });

  it("proceeds unchanged and logs a warning when verifyImpl is absent (backward compatible)", async () => {
    const fetchImpl = makeFetch([{ ok: true }]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const candidate = { facility: makeCandidate(), provenance: { sources: ["https://example.com/new"] } };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [],
    });

    expect(summary.submitted).toBe(1);
    const warnedAboutVerification = warnSpy.mock.calls.some(
      ([msg]) => typeof msg === "string" && /verif/i.test(msg)
    );
    expect(warnedAboutVerification).toBe(true);
    warnSpy.mockRestore();
  });

  it("aborts the entire run loudly (rejects, never resolves) the moment a source verdict is unavailable", async () => {
    const fetchImpl = makeFetch([]);
    const verifyImpl = makeVerifyImpl(() => ({ verdict: "unavailable", reason: "http_error_404" }));
    const candidates = [
      { facility: makeCandidate({ id: "unavailable-1" }), provenance: { sources: ["https://example.com/new"] } },
      { facility: makeCandidate({ id: "unavailable-2" }), provenance: { sources: ["https://example.com/other"] } },
    ];

    await expect(
      runSubmit(candidates, baseOpts(), { fetchImpl, existingFacilities: [], verifyImpl })
    ).rejects.toThrow(/http_error_404/);

    // Must abort on the FIRST unavailable verdict — never mark it
    // skippedUnverified and move on to the second candidate.
    expect(verifyImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aborts loudly on an unavailable verdict regardless of the specific reason string (not special-cased to http_error_404)", async () => {
    const fetchImpl = makeFetch([]);
    // A timeout (not yet implemented upstream, but approved/incoming for the
    // Ollama call and the Wayback lookup) will surface through callOllama as
    // a NEW reason string this gate has never seen before — the abort path
    // must fire on the verdict alone, never on matching a known reason.
    const verifyImpl = makeVerifyImpl(() => ({ verdict: "unavailable", reason: "timeout_after_10000ms" }));
    const candidate = { facility: makeCandidate({ id: "timeout-1" }), provenance: { sources: ["https://example.com/slow"] } };

    await expect(
      runSubmit([candidate], baseOpts(), { fetchImpl, existingFacilities: [], verifyImpl })
    ).rejects.toThrow(/timeout_after_10000ms/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("runSubmit — status_update intents", () => {
  function makeStatusUpdate(overrides: Record<string, unknown> = {}) {
    return {
      targetFacilityId: "existing-facility-tx",
      status: "under_construction",
      date: "2026-07-16",
      note: "groundbreaking confirmed",
      sources: [
        { url: "https://example.com/groundbreaking", label: "Groundbreaking report", retrievedAt: "2026-07-16", kind: "press" },
      ],
      ...overrides,
    };
  }

  it("submits a valid status_update as kind=status_update with the intent as payload", async () => {
    const fetchImpl = makeFetch([{ ok: true, status: 200 }]);
    const candidate = {
      statusUpdate: makeStatusUpdate(),
      provenance: { sources: ["https://example.com/groundbreaking"], discoveredBy: "test" },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.submitted).toBe(1);
    expect(summary.submittedIds).toEqual(["existing-facility-tx"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.kind).toBe("status_update");
    expect(body.targetFacilityId).toBe("existing-facility-tx");
    // payload is the parsed StatusUpdateIntent (statusUpdateIntentSchema) — it
    // does not include targetFacilityId, which lives at the envelope level.
    const { targetFacilityId: omittedTargetId, ...expectedIntent } = makeStatusUpdate();
    expect(omittedTargetId).toBe("existing-facility-tx"); // targetFacilityId lives at the envelope level, not inside payload
    expect(body.payload).toEqual(expectedIntent);
    expect(body.provenance.sources).toEqual(["https://example.com/groundbreaking"]);
    expect(body.provenance.discoveredBy).toBe("test");
  });

  it("skips a status_update whose targetFacilityId is not an existing facility", async () => {
    const fetchImpl = makeFetch([]);
    const candidate = {
      statusUpdate: makeStatusUpdate({ targetFacilityId: "no-such-facility" }),
      provenance: { sources: ["https://example.com/x"] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.skippedInvalid).toBe(1);
    expect(summary.submitted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips a status_update with empty sources as a malformed intent", async () => {
    const fetchImpl = makeFetch([]);
    const candidate = {
      statusUpdate: makeStatusUpdate({ sources: [] }),
      provenance: { sources: ["https://example.com/x"] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.skippedInvalid).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips a status_update with an invalid status value as a malformed intent", async () => {
    const fetchImpl = makeFetch([]);
    const candidate = {
      statusUpdate: makeStatusUpdate({ status: "not-a-real-status" }),
      provenance: { sources: ["https://example.com/x"] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.skippedInvalid).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("routes a mixed array of a new facility, a status_update, and an existing-id full update correctly", async () => {
    const fetchImpl = makeFetch([{ ok: true }, { ok: true }, { ok: true }]);
    const candidates = [
      { facility: makeCandidate({ id: "mixed-new-tx" }), provenance: { sources: ["https://x/new"] } },
      { statusUpdate: makeStatusUpdate(), provenance: { sources: ["https://x/status"] } },
      {
        facility: makeCandidate({ id: "existing-facility-tx", name: "Existing Facility Corrected" }),
        provenance: { sources: ["https://x/correction"] },
      },
    ];

    const summary = await runSubmit(candidates, baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.submitted).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const kinds = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init!.body as string).kind);
    expect(kinds).toEqual(["create", "status_update", "update"]);
  });

  it("caps submissions at --max across mixed facility and status_update types", async () => {
    const fetchImpl = makeFetch([{ ok: true }, { ok: true }]);
    const candidates = [
      { facility: makeCandidate({ id: "cap-mixed-1" }), provenance: { sources: ["https://x/1"] } },
      { statusUpdate: makeStatusUpdate(), provenance: { sources: ["https://x/2"] } },
      { facility: makeCandidate({ id: "cap-mixed-3" }), provenance: { sources: ["https://x/3"] } },
    ];

    const summary = await runSubmit(candidates, baseOpts({ max: 2 }), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.submitted).toBe(2);
    expect(summary.skippedOverCap).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("dry-run logs the status_update line and does not POST", async () => {
    const fetchImpl = makeFetch([]);
    const candidate = { statusUpdate: makeStatusUpdate(), provenance: { sources: ["https://example.com/x"] } };

    const summary = await runSubmit([candidate], baseOpts({ dryRun: true }), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.submitted).toBe(1);
    expect(summary.submittedIds).toEqual(["existing-facility-tx"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("gates the status_update seam — all-rejected sources skip it as unverified, resolving entityName from the existing facility", async () => {
    const fetchImpl = makeFetch([]);
    const verifyImpl = makeVerifyImpl(() => ({ verdict: "rejected" }));
    const candidate = { statusUpdate: makeStatusUpdate(), provenance: { sources: ["https://example.com/x"] } };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
      verifyImpl,
    });

    expect(summary.skippedUnverified).toBe(1);
    expect(summary.submitted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(verifyImpl).toHaveBeenCalledWith(
      "https://example.com/x",
      expect.objectContaining({ entityName: "Existing Facility" })
    );
  });

  it("gates the status_update seam — an EMPTY provenance.sources produces a non-empty skip-unverified reason, never a dangling '— '", async () => {
    const fetchImpl = makeFetch([]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // provenance.sources is empty — the intent's own `sources` field (inside
    // makeStatusUpdate()) is unrelated and stays non-empty so this candidate
    // reaches the verification gate instead of failing schema validation.
    const verifyImpl = makeVerifyImpl(() => ({ verdict: "rejected" }));
    const candidate = { statusUpdate: makeStatusUpdate(), provenance: { sources: [] } };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
      verifyImpl,
    });

    expect(summary.skippedUnverified).toBe(1);
    expect(summary.submitted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    // Nothing to iterate over, so the injected verifyImpl is never reached.
    expect(verifyImpl).not.toHaveBeenCalled();

    const skipLine = logSpy.mock.calls
      .map(([msg]) => msg)
      .find((msg) => typeof msg === "string" && msg.startsWith("skip unverified:"));
    expect(skipLine).toBeDefined();
    const afterDash = (skipLine as string).split("—")[1]?.trim() ?? "";
    expect(afterDash.length).toBeGreaterThan(0);
    expect(afterDash.toLowerCase()).toContain("no sources");
    logSpy.mockRestore();
  });
});

describe("runSubmit — enrichment_update intents", () => {
  function makeEnrichmentUpdate(overrides: Record<string, unknown> = {}) {
    return {
      targetFacilityId: "existing-facility-tx",
      date: "2026-07-20",
      sources: [
        { url: "https://example.com/enrichment", label: "10-Q filing", retrievedAt: "2026-07-20", kind: "filing" },
      ],
      fields: { investmentUsd: 500000000 },
      ...overrides,
    };
  }

  it("submits a valid enrichment_update as kind=enrichment_update with targetFacilityId stripped from payload", async () => {
    const fetchImpl = makeFetch([{ ok: true, status: 200 }]);
    const candidate = {
      enrichmentUpdate: makeEnrichmentUpdate(),
      provenance: { sources: ["https://example.com/enrichment"], discoveredBy: "test" },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.submitted).toBe(1);
    expect(summary.submittedIds).toEqual(["existing-facility-tx"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.kind).toBe("enrichment_update");
    expect(body.targetFacilityId).toBe("existing-facility-tx");
    // payload is the parsed EnrichmentUpdateIntent (enrichmentUpdateIntentSchema,
    // which is .strict() and does not declare targetFacilityId) — it must not
    // include targetFacilityId, which lives at the envelope level.
    const { targetFacilityId: omittedTargetId, ...expectedIntent } = makeEnrichmentUpdate();
    expect(omittedTargetId).toBe("existing-facility-tx");
    expect(body.payload).toEqual(expectedIntent);
    expect(body.provenance.sources).toEqual(["https://example.com/enrichment"]);
    expect(body.provenance.discoveredBy).toBe("test");
  });

  it("skips an enrichment_update whose targetFacilityId is missing", async () => {
    const fetchImpl = makeFetch([]);
    const rest = Object.fromEntries(
      Object.entries(makeEnrichmentUpdate()).filter(([key]) => key !== "targetFacilityId")
    );
    const candidate = {
      enrichmentUpdate: rest,
      provenance: { sources: ["https://example.com/x"] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.skippedInvalid).toBe(1);
    expect(summary.submitted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips an enrichment_update whose targetFacilityId is not an existing facility", async () => {
    const fetchImpl = makeFetch([]);
    const candidate = {
      enrichmentUpdate: makeEnrichmentUpdate({ targetFacilityId: "no-such-facility" }),
      provenance: { sources: ["https://example.com/x"] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.skippedInvalid).toBe(1);
    expect(summary.submitted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips an enrichment_update with an unknown field key as malformed (strict schema)", async () => {
    const fetchImpl = makeFetch([]);
    const candidate = {
      enrichmentUpdate: makeEnrichmentUpdate({ fields: { notARealField: true } }),
      provenance: { sources: ["https://example.com/x"] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.skippedInvalid).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips an enrichment_update with an out-of-range sourceRel as malformed", async () => {
    const fetchImpl = makeFetch([]);
    const candidate = {
      enrichmentUpdate: makeEnrichmentUpdate({
        fields: { community: { status: "supportive", sourceRel: 5 } },
      }),
      provenance: { sources: ["https://example.com/x"] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.skippedInvalid).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("dry-run logs the enrichment_update line and does not POST", async () => {
    const fetchImpl = makeFetch([]);
    const candidate = {
      enrichmentUpdate: makeEnrichmentUpdate(),
      provenance: { sources: ["https://example.com/x"] },
    };

    const summary = await runSubmit([candidate], baseOpts({ dryRun: true }), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.submitted).toBe(1);
    expect(summary.submittedIds).toEqual(["existing-facility-tx"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("processes discovery (net-new + status_update) ahead of enrichment_update under a tight shared --max cap", async () => {
    const fetchImpl = makeFetch([{ ok: true }]);
    // enrichment_update appears FIRST in the array, the net-new create SECOND —
    // discovery-first ordering means the create still wins the single cap slot.
    const candidates = [
      { enrichmentUpdate: makeEnrichmentUpdate(), provenance: { sources: ["https://x/enrich"] } },
      { facility: makeCandidate({ id: "discovery-priority-tx" }), provenance: { sources: ["https://x/new"] } },
    ];

    const summary = await runSubmit(candidates, baseOpts({ max: 1 }), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.submitted).toBe(1);
    expect(summary.submittedIds).toEqual(["discovery-priority-tx"]);
    expect(summary.skippedOverCap).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init!.body as string).kind).toBe("create");
  });

  it("gates the enrichment_update seam — one verified source lets it through, resolving entityName from the existing facility", async () => {
    const fetchImpl = makeFetch([{ ok: true }]);
    const verifyImpl = makeVerifyImpl(() => ({ verdict: "verified" }));
    const candidate = {
      enrichmentUpdate: makeEnrichmentUpdate(),
      provenance: { sources: ["https://example.com/enrichment"] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
      verifyImpl,
    });

    expect(summary.submitted).toBe(1);
    expect(summary.skippedUnverified).toBe(0);
    expect(verifyImpl).toHaveBeenCalledWith(
      "https://example.com/enrichment",
      expect.objectContaining({ entityName: "Existing Facility" })
    );
  });
});

describe("normalizeCandidates — status_update classification", () => {
  it("classifies a { statusUpdate, provenance } entry distinctly from facility entries", () => {
    const statusUpdateEntry = {
      statusUpdate: { targetFacilityId: "existing-facility-tx", status: "operational", date: "2026-07-16", sources: [] },
      provenance: { sources: ["https://x"] },
    };
    const bareFacility = makeCandidate();

    const [a, b] = normalizeCandidates([statusUpdateEntry, bareFacility]);

    expect(a.type).toBe("status_update");
    if (a.type === "status_update") {
      expect(a.targetFacilityId).toBe("existing-facility-tx");
    }
    expect(b.type).toBe("facility");
  });
});

describe("normalizeCandidates — enrichment_update classification", () => {
  it("classifies an { enrichmentUpdate, provenance } entry distinctly from facility and status_update entries", () => {
    const enrichmentUpdateEntry = {
      enrichmentUpdate: {
        targetFacilityId: "existing-facility-tx",
        date: "2026-07-20",
        sources: [],
        fields: {},
      },
      provenance: { sources: ["https://x"] },
    };
    const bareFacility = makeCandidate();

    const [a, b] = normalizeCandidates([enrichmentUpdateEntry, bareFacility]);

    expect(a.type).toBe("enrichment_update");
    if (a.type === "enrichment_update") {
      expect(a.targetFacilityId).toBe("existing-facility-tx");
    }
    expect(b.type).toBe("facility");
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

describe("runSubmit — restricted-source guard", () => {
  const RESTRICTED_URL = "https://interconnection.fyi/queue/999";
  const RESTRICTED_SUBDOMAIN_URL = "https://www.interconnection.fyi/queue/998";
  const VERIFIED_URL = "https://example.com/verified";

  it("create/update: strips a restricted source from doc.sources AND provenance.sources while the candidate still stages", async () => {
    const fetchImpl = makeFetch([{ ok: true, status: 201 }]);
    const candidate = {
      facility: makeCandidate({
        id: "restricted-strip-tx",
        sources: [
          { url: VERIFIED_URL, label: "Verified source", retrievedAt: "2026-09-20", kind: "press" },
          { url: RESTRICTED_URL, label: "Queue listing", retrievedAt: "2026-09-20", kind: "iso_queue" },
        ],
      }),
      provenance: { sources: [VERIFIED_URL, RESTRICTED_URL] },
    };

    const summary = await runSubmit([candidate], baseOpts(), { fetchImpl, existingFacilities: [] });

    expect(summary.submitted).toBe(1);
    expect(summary.skippedRestrictedSource).toBe(0);
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.payload.sources).toEqual([
      { url: VERIFIED_URL, label: "Verified source", retrievedAt: "2026-09-20", kind: "press" },
    ]);
    expect(body.provenance.sources).toEqual([VERIFIED_URL]);
  });

  it("create/update ADVERSARIAL ordering: a restricted source at index 0 with a LATER sourceIndex ref still resolves to the same URL after the strip", async () => {
    const fetchImpl = makeFetch([{ ok: true, status: 201 }]);
    const candidate = {
      facility: makeCandidate({
        id: "adversarial-order-tx",
        sources: [
          { url: RESTRICTED_URL, label: "Queue listing", retrievedAt: "2026-09-20", kind: "iso_queue" },
          { url: VERIFIED_URL, label: "Groundbreaking", retrievedAt: "2026-09-20", kind: "press" },
        ],
        // References index 1 — the source AFTER the restricted one — on
        // purpose: the real 2026-09-21 offenders all happened to have refs
        // only BELOW the restricted index, so a fixture mirroring prod would
        // pass vacuously even with a naive index-shift (rather than
        // URL-identity) remap. This ref is deliberately on the other side.
        statusHistory: [{ status: "under_construction", date: "2026-09-20", sourceIndex: 1 }],
      }),
      provenance: { sources: [RESTRICTED_URL, VERIFIED_URL] },
    };

    const summary = await runSubmit([candidate], baseOpts(), { fetchImpl, existingFacilities: [] });

    expect(summary.submitted).toBe(1);
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.payload.sources).toHaveLength(1);
    // The URL-IDENTITY invariant, asserted directly: whatever index the ref
    // now carries, it must resolve to the SAME url it resolved to before
    // the strip (VERIFIED_URL) — never an arithmetic guess that happens to
    // land in-range.
    expect(body.payload.sources[body.payload.statusHistory[0].sourceIndex].url).toBe(VERIFIED_URL);
    expect(body.payload.statusHistory[0].sourceIndex).toBe(0);
  });

  it("create/update: skips a candidate whose sources are ALL restricted, without POSTing", async () => {
    const fetchImpl = makeFetch([]);
    const candidate = {
      facility: makeCandidate({
        id: "all-restricted-tx",
        sources: [{ url: RESTRICTED_URL, label: "Queue listing", retrievedAt: "2026-09-20", kind: "iso_queue" }],
      }),
      // provenance.sources is deliberately a DIFFERENT, non-restricted URL —
      // isolates this test to doc.sources's own emptiness guard, rather than
      // also (coincidentally) tripping the separate provenance.sources guard.
      provenance: { sources: [VERIFIED_URL] },
    };

    const summary = await runSubmit([candidate], baseOpts(), { fetchImpl, existingFacilities: [] });

    expect(summary.skippedRestrictedSource).toBe(1);
    expect(summary.submitted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("create/update: a strip that would empty sources is skipped rather than staged with an empty sources array", async () => {
    const fetchImpl = makeFetch([]);
    const candidate = {
      facility: makeCandidate({
        id: "all-restricted-multi-tx",
        sources: [
          { url: RESTRICTED_URL, label: "Queue listing A", retrievedAt: "2026-09-20", kind: "iso_queue" },
          { url: RESTRICTED_SUBDOMAIN_URL, label: "Queue listing B (subdomain)", retrievedAt: "2026-09-20", kind: "iso_queue" },
        ],
      }),
      // Isolated from the provenance.sources guard, same reasoning as above.
      provenance: { sources: [VERIFIED_URL] },
    };

    const summary = await runSubmit([candidate], baseOpts(), { fetchImpl, existingFacilities: [] });

    expect(summary.skippedRestrictedSource).toBe(1);
    expect(summary.submitted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("logs a 'stripped restricted source(s)' line naming the facility id and URL when a strip succeeds — NOT counted as a skip", async () => {
    const fetchImpl = makeFetch([{ ok: true }]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const candidate = {
      facility: makeCandidate({
        id: "logged-strip-tx",
        sources: [
          { url: VERIFIED_URL, label: "Verified", retrievedAt: "2026-09-20", kind: "press" },
          { url: RESTRICTED_URL, label: "Queue listing", retrievedAt: "2026-09-20", kind: "iso_queue" },
        ],
      }),
      provenance: { sources: [VERIFIED_URL, RESTRICTED_URL] },
    };

    const summary = await runSubmit([candidate], baseOpts(), { fetchImpl, existingFacilities: [] });

    expect(summary.submitted).toBe(1);
    expect(summary.skippedRestrictedSource).toBe(0);
    const strippedLine = logSpy.mock.calls
      .map(([msg]) => msg)
      .find((msg) => typeof msg === "string" && msg.startsWith("stripped restricted source(s)"));
    expect(strippedLine).toBeDefined();
    expect(strippedLine).toContain("logged-strip-tx");
    expect(strippedLine).toContain(RESTRICTED_URL);
    logSpy.mockRestore();
  });

  it("status_update: strips a restricted source from the intent's own sources and still stages it", async () => {
    const fetchImpl = makeFetch([{ ok: true }]);
    const candidate = {
      statusUpdate: {
        targetFacilityId: "existing-facility-tx",
        status: "under_construction",
        date: "2026-09-20",
        sources: [
          { url: RESTRICTED_URL, label: "Queue listing", retrievedAt: "2026-09-20", kind: "iso_queue" },
          { url: VERIFIED_URL, label: "Groundbreaking report", retrievedAt: "2026-09-20", kind: "press" },
        ],
      },
      provenance: { sources: [RESTRICTED_URL, VERIFIED_URL] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.submitted).toBe(1);
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.payload.sources).toEqual([
      { url: VERIFIED_URL, label: "Groundbreaking report", retrievedAt: "2026-09-20", kind: "press" },
    ]);
    expect(body.provenance.sources).toEqual([VERIFIED_URL]);
  });

  it("enrichment_update ADVERSARIAL ordering: strips a restricted source and remaps a LATER sourceRel by URL identity", async () => {
    const fetchImpl = makeFetch([{ ok: true }]);
    const candidate = {
      enrichmentUpdate: {
        targetFacilityId: "existing-facility-tx",
        date: "2026-09-20",
        sources: [
          { url: RESTRICTED_URL, label: "Queue listing", retrievedAt: "2026-09-20", kind: "iso_queue" },
          { url: VERIFIED_URL, label: "Subsidy filing", retrievedAt: "2026-09-20", kind: "filing" },
        ],
        fields: {
          subsidies: [{ program: "Tax abatement", sourceRel: 1 }],
        },
      },
      provenance: { sources: [RESTRICTED_URL, VERIFIED_URL] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.submitted).toBe(1);
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.payload.sources).toHaveLength(1);
    expect(body.payload.sources[0].url).toBe(VERIFIED_URL);
    const remappedRel = body.payload.fields.subsidies[0].sourceRel;
    expect(remappedRel).toBe(0);
    expect(body.payload.sources[remappedRel].url).toBe(VERIFIED_URL);
  });

  it("enrichment_update: a reSourced sourceRel pointing DIRECTLY at the restricted source is skipped as unmappable, even though a different source survives the strip", async () => {
    // Distinct from the "would empty" tests above: here the strip leaves
    // `sources` non-empty (VERIFIED_URL survives) — the failure must come
    // from the remap loop finding no honest new home for the reference,
    // not from the emptiness guard.
    const fetchImpl = makeFetch([]);
    const candidate = {
      enrichmentUpdate: {
        targetFacilityId: "existing-facility-tx",
        date: "2026-09-20",
        sources: [
          { url: RESTRICTED_URL, label: "Queue listing", retrievedAt: "2026-09-20", kind: "iso_queue" },
          { url: VERIFIED_URL, label: "Unrelated filing", retrievedAt: "2026-09-20", kind: "filing" },
        ],
        fields: {},
        reSourced: [{ replacesUrl: "https://example.com/old", sourceRel: 0 }],
      },
      // Isolated from the provenance.sources guard, same reasoning as above.
      provenance: { sources: [VERIFIED_URL] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [EXISTING_FACILITY],
    });

    expect(summary.skippedRestrictedSource).toBe(1);
    expect(summary.submitted).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ADVERSARIAL duplicate URL: a ref pointing at the SECOND of two same-URL sources keeps that source's OWN metadata after the strip, not the first occurrence's", async () => {
    const fetchImpl = makeFetch([{ ok: true, status: 201 }]);
    const DUP_URL = "https://example.com/duplicate-url";
    const candidate = {
      facility: makeCandidate({
        id: "duplicate-url-tx",
        sources: [
          { url: DUP_URL, label: "Report A", retrievedAt: "2026-09-20", kind: "press" },
          { url: RESTRICTED_URL, label: "Queue listing", retrievedAt: "2026-09-20", kind: "iso_queue" },
          { url: DUP_URL, label: "Report B", retrievedAt: "2026-09-20", kind: "subsidy" },
        ],
        // References index 2 — the SECOND occurrence of DUP_URL, on the
        // other side of the restricted entry — on purpose: a URL-search
        // remap (`kept.findIndex((s) => s.url === url)`) returns the FIRST
        // match and would silently swap this ref onto "Report A"/press even
        // though the URL itself is preserved. This shape is real in prod
        // data: google-skyway-pine-island-mn cites one URL twice with
        // different kind/label.
        statusHistory: [{ status: "under_construction", date: "2026-09-20", sourceIndex: 2 }],
      }),
      provenance: { sources: [DUP_URL] },
    };

    const summary = await runSubmit([candidate], baseOpts(), { fetchImpl, existingFacilities: [] });

    expect(summary.submitted).toBe(1);
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.payload.sources).toHaveLength(2);
    const remappedIndex = body.payload.statusHistory[0].sourceIndex;
    // Asserting only the URL would pass under the OLD (findIndex) code too,
    // since both entries share DUP_URL — the metadata is the only thing
    // that distinguishes correct behavior from the swapped-citation bug.
    expect(body.payload.sources[remappedIndex].url).toBe(DUP_URL);
    expect(body.payload.sources[remappedIndex].label).toBe("Report B");
    expect(body.payload.sources[remappedIndex].kind).toBe("subsidy");
  });

  it("verification gate ACTIVE + restricted source coexist: the gate approves via the non-restricted source, and the strip still removes the restricted one from doc.sources", async () => {
    const fetchImpl = makeFetch([{ ok: true, status: 201 }]);
    const verifyImpl = makeVerifyImpl((url) => ({
      verdict: url === VERIFIED_URL ? "verified" : "rejected",
    }));
    const candidate = {
      facility: makeCandidate({
        id: "gate-and-restricted-tx",
        sources: [
          { url: VERIFIED_URL, label: "Verified source", retrievedAt: "2026-09-20", kind: "press" },
          { url: RESTRICTED_URL, label: "Queue listing", retrievedAt: "2026-09-20", kind: "iso_queue" },
        ],
      }),
      provenance: { sources: [VERIFIED_URL] },
    };

    const summary = await runSubmit([candidate], baseOpts(), {
      fetchImpl,
      existingFacilities: [],
      verifyImpl,
    });

    expect(verifyImpl).toHaveBeenCalled();
    expect(summary.submitted).toBe(1);
    expect(summary.skippedUnverified).toBe(0);
    expect(summary.skippedRestrictedSource).toBe(0);
    const [, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    // The strip ran despite (not because of) the active gate — it must
    // remove the restricted entry regardless of whether verification is on,
    // since the strip lives outside the `!opts.dryRun && deps.verifyImpl`
    // block entirely.
    expect(body.payload.sources).toEqual([
      { url: VERIFIED_URL, label: "Verified source", retrievedAt: "2026-09-20", kind: "press" },
    ]);
  });
});
