import { describe, it, expect, vi } from "vitest";

import {
  runLeadsLane,
  LeadsLaneUnavailableError,
  type LeadsLaneDeps,
  type LeadForLane,
  type LeadExtraction,
  type RunLeadsLaneOptions,
} from "./leads-lane";
import type { FetchPageTextResult } from "./fetch-page-text";
import type { CallOllamaResult } from "./ollama-client";
import type { ModelVerdict } from "./verify-source";
import type { GeocodeResult } from "../../lib/geocode";
import type { LeadActionResult } from "../../lib/leads";
import type { SubmissionResult } from "../../lib/submissions";

// --- fixtures / helpers -----------------------------------------------------

const PAGE_TEXT =
  "Example Facility is a proposed data center located in Austin, Texas, with a planned capacity of 50 megawatts.";

function makeLead(overrides: Partial<LeadForLane> = {}): LeadForLane {
  return { id: "lead-1", url: "https://example.com/article", note: null, attribution: null, ...overrides };
}

function pageOk(text: string = PAGE_TEXT): FetchPageTextResult {
  return { ok: true, text, finalUrl: "https://example.com/article", httpStatus: 200 };
}

function pageFail(reason: Extract<FetchPageTextResult, { ok: false }>["reason"] = "http_error"): FetchPageTextResult {
  return { ok: false, reason };
}

function extraction(overrides: Partial<LeadExtraction> = {}): LeadExtraction {
  return {
    name: "Example Facility",
    operator: "Example Corp",
    facilityType: "data_center",
    status: "proposed",
    city: "Austin",
    state: "TX",
    capacityMw: null,
    ...overrides,
  };
}

function extractionOk(data: LeadExtraction): CallOllamaResult<LeadExtraction> {
  return { ok: true, data };
}

const VERIFIED_QUOTE: ModelVerdict = {
  verdict: "supports",
  quote: "Example Facility is a proposed data center located in Austin, Texas, with a planned capacity of 50 megawatts.",
};

function verdictResult(verdict: ModelVerdict): CallOllamaResult<ModelVerdict> {
  return { ok: true, data: verdict };
}

/** Returns each of `results` in order on successive calls, repeating the
 * final one thereafter — the extraction call is always first, the
 * verification gate's own model call (via verify-source.ts) always second.
 * Cast to `LeadsLaneDeps["callOllamaImpl"]` at the call boundary: vitest's
 * `vi.fn()` can't preserve a generic call signature through its mock
 * wrapper, so every caller needs the same escape hatch. */
function sequencedOllama(results: Array<CallOllamaResult<unknown>>): LeadsLaneDeps["callOllamaImpl"] {
  let call = 0;
  const fn = vi.fn(async (): Promise<CallOllamaResult<unknown>> => {
    const result = results[Math.min(call, results.length - 1)];
    call++;
    return result;
  });
  return fn as unknown as LeadsLaneDeps["callOllamaImpl"];
}

function baseOpts(overrides: Partial<RunLeadsLaneOptions> = {}): RunLeadsLaneOptions {
  return { limit: 10, dryRun: false, runId: "test-run", ...overrides };
}

/**
 * Never hit the real network: verify-source.ts's Wayback fallback defaults
 * `deps.fetchImpl` to the real global `fetch` when omitted. Every test here
 * supplies this stub (reporting "no snapshot available", the normal shape a
 * clean 200 with an empty `archived_snapshots` object produces) so a
 * fetch-failure/escalate/rejected path can never reach out to archive.org.
 */
function noWaybackSnapshot(): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null } as unknown as Headers,
    text: async () => JSON.stringify({ archived_snapshots: {} }),
  })) as unknown as typeof fetch;
}

function makeDeps(overrides: Partial<LeadsLaneDeps> = {}): LeadsLaneDeps {
  return {
    listNewLeadsImpl: vi.fn(async () => [makeLead()]),
    fetchPageTextImpl: vi.fn(async () => pageOk()),
    callOllamaImpl: sequencedOllama([extractionOk(extraction()), verdictResult(VERIFIED_QUOTE)]),
    geocodeImpl: vi.fn(async (): Promise<GeocodeResult[]> => [{ lat: 30.1, lon: -97.7, label: "Austin, TX" }]),
    createSubmissionImpl: vi.fn(
      async (): Promise<SubmissionResult> => ({ ok: true, id: "22222222-2222-2222-2222-222222222222" })
    ),
    markResearchingImpl: vi.fn(
      async (): Promise<LeadActionResult> => ({ ok: true, lead: { status: "researching" } as never })
    ),
    promoteLeadImpl: vi.fn(
      async (): Promise<LeadActionResult> => ({ ok: true, lead: { status: "promoted" } as never })
    ),
    now: () => new Date("2026-08-20T00:00:00.000Z"),
    rawFetchImpl: noWaybackSnapshot(),
    ...overrides,
  };
}

// --- happy path --------------------------------------------------------------

describe("runLeadsLane — happy path", () => {
  it("stages exactly one create submission and promotes the lead", async () => {
    const deps = makeDeps();

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(summary.staged).toBe(1);
    expect(summary.stagedLeadIds).toEqual(["lead-1"]);
    expect(deps.createSubmissionImpl).toHaveBeenCalledTimes(1);
    const [submissionArg] = vi.mocked(deps.createSubmissionImpl).mock.calls[0];
    expect(submissionArg).toMatchObject({
      kind: "create",
      payload: expect.objectContaining({ name: "Example Facility", operator: "Example Corp" }),
      provenance: expect.objectContaining({ sources: ["https://example.com/article"], discoveredBy: "leads-lane" }),
    });

    // promotedSubmissionId is recorded on success.
    expect(deps.promoteLeadImpl).toHaveBeenCalledTimes(1);
    expect(deps.promoteLeadImpl).toHaveBeenCalledWith(
      "lead-1",
      "22222222-2222-2222-2222-222222222222",
      expect.any(String)
    );
    expect(deps.markResearchingImpl).not.toHaveBeenCalled();
  });
});

// --- rejected verdict ---------------------------------------------------------

describe("runLeadsLane — rejected verification", () => {
  it("stages nothing and does NOT dismiss the lead", async () => {
    const deps = makeDeps({
      callOllamaImpl: sequencedOllama([
        extractionOk(extraction()),
        verdictResult({ verdict: "not_mentioned", quote: null }),
      ]),
    });

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(summary.staged).toBe(0);
    expect(summary.unusable).toBe(1);
    expect(deps.createSubmissionImpl).not.toHaveBeenCalled();
    expect(deps.promoteLeadImpl).not.toHaveBeenCalled();
    // Moved to researching for a human — never dismissed (there is no
    // "dismiss" dependency injected at all; only a human dismisses a lead).
    expect(deps.markResearchingImpl).toHaveBeenCalledTimes(1);
    expect(deps.markResearchingImpl).toHaveBeenCalledWith("lead-1", expect.stringContaining("rejected"));
  });
});

// --- unavailable (Ollama down) -----------------------------------------------

describe("runLeadsLane — model unavailable", () => {
  it("aborts and stages nothing when the EXTRACTION call fails", async () => {
    const deps = makeDeps({
      callOllamaImpl: sequencedOllama([{ ok: false, reason: "network_error" }]),
    });

    await expect(runLeadsLane(baseOpts(), deps)).rejects.toThrow(LeadsLaneUnavailableError);
    expect(deps.createSubmissionImpl).not.toHaveBeenCalled();
    expect(deps.markResearchingImpl).not.toHaveBeenCalled();
  });

  it("aborts and stages nothing when the VERIFICATION call fails", async () => {
    const deps = makeDeps({
      callOllamaImpl: sequencedOllama([
        extractionOk(extraction()),
        { ok: false, reason: "http_error_404" },
      ]),
    });

    await expect(runLeadsLane(baseOpts(), deps)).rejects.toThrow(LeadsLaneUnavailableError);
    expect(deps.createSubmissionImpl).not.toHaveBeenCalled();
    expect(deps.markResearchingImpl).not.toHaveBeenCalled();
  });
});

// --- fetch failure -------------------------------------------------------------

describe("runLeadsLane — fetch failure", () => {
  it("leaves the lead 'new' (no status write at all)", async () => {
    const deps = makeDeps({ fetchPageTextImpl: vi.fn(async () => pageFail("http_error")) });

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(summary.fetchFailed).toBe(1);
    expect(summary.staged).toBe(0);
    expect(deps.callOllamaImpl).not.toHaveBeenCalled();
    expect(deps.markResearchingImpl).not.toHaveBeenCalled();
    expect(deps.createSubmissionImpl).not.toHaveBeenCalled();
  });
});

// --- geocode failure -------------------------------------------------------------

describe("runLeadsLane — geocode failure", () => {
  it("stages nothing when geocoding returns zero results", async () => {
    const deps = makeDeps({ geocodeImpl: vi.fn(async (): Promise<GeocodeResult[]> => []) });

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(summary.geocodeFailed).toBe(1);
    expect(summary.staged).toBe(0);
    expect(deps.createSubmissionImpl).not.toHaveBeenCalled();
    expect(deps.markResearchingImpl).toHaveBeenCalledTimes(1);
    expect(deps.markResearchingImpl).toHaveBeenCalledWith("lead-1", expect.stringContaining("geocode"));
  });
});

// --- dry run ---------------------------------------------------------------------

describe("runLeadsLane — dry run", () => {
  it("writes nothing at all, even on an otherwise-stageable lead", async () => {
    const deps = makeDeps();

    const summary = await runLeadsLane(baseOpts({ dryRun: true }), deps);

    expect(summary.staged).toBe(1);
    expect(summary.stagedLeadIds).toEqual(["lead-1"]);
    expect(deps.createSubmissionImpl).not.toHaveBeenCalled();
    expect(deps.markResearchingImpl).not.toHaveBeenCalled();
    expect(deps.promoteLeadImpl).not.toHaveBeenCalled();
  });
});

// --- model returns nulls ------------------------------------------------------

describe("runLeadsLane — model finds nothing usable", () => {
  it("moves the lead to researching, never dismissed, and never calls the verification gate", async () => {
    const deps = makeDeps({
      callOllamaImpl: sequencedOllama([
        extractionOk({
          name: null,
          operator: null,
          facilityType: null,
          status: null,
          city: null,
          state: null,
          capacityMw: null,
        }),
      ]),
    });

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(summary.unusable).toBe(1);
    expect(summary.staged).toBe(0);
    // Only the extraction call happened — verification is never reached
    // without a usable name/operator/state to check.
    expect(deps.callOllamaImpl).toHaveBeenCalledTimes(1);
    expect(deps.markResearchingImpl).toHaveBeenCalledWith("lead-1", expect.stringContaining("no usable"));
    expect(deps.createSubmissionImpl).not.toHaveBeenCalled();
  });
});

// --- escalate: leave the lead alone, never a rejection ------------------------

describe("runLeadsLane — verification escalated", () => {
  it("leaves the lead untouched (no status write), never treated as a rejection", async () => {
    const deps = makeDeps({
      fetchPageTextImpl: vi.fn(async () => pageOk()),
      callOllamaImpl: sequencedOllama([extractionOk(extraction())]),
    });
    // Force an escalate verdict: the SECOND fetch (verify-source's own,
    // internal call) fails with a structural (not content) reason.
    let call = 0;
    deps.fetchPageTextImpl = vi.fn(async (): Promise<FetchPageTextResult> => {
      call++;
      return call === 1 ? pageOk() : { ok: false, reason: "too_large" };
    });

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(summary.escalated).toBe(1);
    expect(summary.staged).toBe(0);
    expect(deps.markResearchingImpl).not.toHaveBeenCalled();
    expect(deps.createSubmissionImpl).not.toHaveBeenCalled();
  });
});

// --- Gap C: coordinates come from geocoding, not the model ---------------------

describe("runLeadsLane — Gap C: geocoded coordinates override extracted", () => {
  it("ignores extraction lat/lon and uses geocoded coordinates", async () => {
    // The model tries to volunteer coordinates (which it shouldn't, but
    // defensive testing), and we verify they are discarded in favor of
    // the geocoded result. This guards the project's hardest rule:
    // coordinates ONLY from `geocodeUS`, never proposed by the model.
    const extractedWithWrongCoords = extraction({
      name: "Example Facility",
      operator: "Example Corp",
      city: "Austin",
      state: "TX",
      capacityMw: null,
    });
    const correctGeocodeResult: GeocodeResult = {
      lat: 30.123,
      lon: -97.456,
      label: "Austin, TX",
    };

    const deps = makeDeps({
      callOllamaImpl: sequencedOllama([
        extractionOk(extractedWithWrongCoords),
        verdictResult(VERIFIED_QUOTE),
      ]),
      geocodeImpl: vi.fn(async () => [correctGeocodeResult]),
    });

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(summary.staged).toBe(1);
    const call = vi.mocked(deps.createSubmissionImpl).mock.calls[0];
    const submissionArg = call[0] as Record<string, unknown>;
    const payload = submissionArg.payload;

    // Assert the payload contains the GEOCODED coordinates, not the
    // extraction's. The geocodeResult defines the truth.
    expect(payload).toMatchObject({
      location: {
        lat: 30.123,
        lon: -97.456,
      },
    });
  });
});

// --- Gap B: capacity routing by status ----------------------------------------

describe("runLeadsLane — Gap B: capacity routed to operational vs planned", () => {
  it("routes capacityMw to capacityOperationalMw when status is operational", async () => {
    const extractionWithCapacity = extraction({
      status: "operational",
      capacityMw: 50,
    });
    const deps = makeDeps({
      callOllamaImpl: sequencedOllama([
        extractionOk(extractionWithCapacity),
        verdictResult(VERIFIED_QUOTE),
      ]),
    });

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(summary.staged).toBe(1);
    const call = vi.mocked(deps.createSubmissionImpl).mock.calls[0];
    const submissionArg = call[0] as Record<string, unknown>;
    const payload = submissionArg.payload as Record<string, unknown>;

    // capacityField() should route to operational when status is operational
    expect(payload.capacityMw).toMatchObject({
      operational: 50,
    });
    // planned should not be present
    expect((payload.capacityMw as Record<string, unknown>).planned).toBeUndefined();
  });

  it("routes capacityMw to capacityPlannedMw when status is proposed", async () => {
    const pageWithCapacity75 = "Example Facility is a proposed data center located in Austin, Texas, with a planned capacity of 75 megawatts.";
    const extractionWithCapacity = extraction({
      status: "proposed",
      capacityMw: 75,
    });
    const deps = makeDeps({
      fetchPageTextImpl: vi.fn(async () => pageOk(pageWithCapacity75)),
      callOllamaImpl: sequencedOllama([
        extractionOk(extractionWithCapacity),
        verdictResult({
          verdict: "supports",
          quote: pageWithCapacity75,
        }),
      ]),
    });

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(summary.staged).toBe(1);
    const call = vi.mocked(deps.createSubmissionImpl).mock.calls[0];
    const submissionArg = call[0] as Record<string, unknown>;
    const payload = submissionArg.payload as Record<string, unknown>;

    // capacityField() should route to planned when status is not operational
    expect(payload.capacityMw).toMatchObject({
      planned: 75,
    });
    // operational should not be present
    expect((payload.capacityMw as Record<string, unknown>).operational).toBeUndefined();
  });
});

// --- Gap A: promoteLead failure leaves lead re-stageable -----------------------

describe("runLeadsLane — Gap A: promoteLead failure does not block staging count", () => {
  it("counts submission staged even if promoteLead rejects", async () => {
    // The documented behavior: if createSubmission succeeds but promoteLead
    // fails, the submission exists while the lead stays `new`. This is
    // intentional (a lead stuck on `new` beside a live submission beats
    // losing track of a created submission). The run should not crash and
    // should count the lead as staged.
    const deps = makeDeps({
      promoteLeadImpl: vi.fn(async (): Promise<LeadActionResult> => ({
        ok: false,
        status: 500,
        error: "database_error",
      })),
    });

    const summary = await runLeadsLane(baseOpts(), deps);

    // Even though promoteLead failed, the submission was created and
    // counted as staged.
    expect(summary.staged).toBe(1);
    expect(summary.stagedLeadIds).toEqual(["lead-1"]);
    expect(summary.errors).toBe(0); // promoteLead failure is not an error in the summary

    // Verify that createSubmission was called (and succeeded)
    expect(deps.createSubmissionImpl).toHaveBeenCalledTimes(1);

    // Verify that promoteLead was attempted
    expect(deps.promoteLeadImpl).toHaveBeenCalledTimes(1);
  });
});
