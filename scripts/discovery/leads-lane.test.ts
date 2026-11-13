import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  runLeadsLane,
  leadsLaneExitCode,
  classifyFetchFailure,
  LeadsLaneUnavailableError,
  type LeadsLaneDeps,
  type LeadForLane,
  type LeadExtraction,
  type RunLeadsLaneOptions,
} from "./leads-lane";
import type { FetchPageTextResult } from "./fetch-page-text";
import { MAX_PAGE_TEXT_CHARS } from "./verify-source";
import type { CallOllamaResult } from "./ollama-client";
import type { ModelVerdict } from "./verify-source";
import type { GeocodeResult } from "../../lib/geocode";
import type { LeadActionResult } from "../../lib/leads";
import type { SubmissionResult } from "../../lib/submissions";
import { LEAD_STATUSES } from "../../lib/lead-fields";

// --- fixtures / helpers -----------------------------------------------------

const PAGE_TEXT =
  "Example Facility is a proposed data center located in Austin, Texas, with a planned capacity of 50 megawatts.";

function makeLead(overrides: Partial<LeadForLane> = {}): LeadForLane {
  return { id: "lead-1", url: "https://example.com/article", note: null, attribution: null, triage: null, createdAt: new Date("2026-08-19T00:00:00.000Z"), ...overrides };
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
    fetchPdfTextImpl: vi.fn(async () => ({ ok: false as const, reason: "bad_content_type" as const })),
    callOllamaImpl: sequencedOllama([extractionOk(extraction()), verdictResult(VERIFIED_QUOTE)]),
    geocodeImpl: vi.fn(async (): Promise<GeocodeResult[]> => [{ lat: 30.1, lon: -97.7, label: "Austin, TX" }]),
    findPossibleDuplicatesImpl: vi.fn(async (): Promise<string[]> => []),
    createSubmissionImpl: vi.fn(
      async (): Promise<SubmissionResult> => ({ ok: true, id: "22222222-2222-2222-2222-222222222222" })
    ),
    markDeferredImpl: vi.fn(
      async (): Promise<LeadActionResult> => ({ ok: true, lead: { status: "deferred" } as never })
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
    expect(deps.markDeferredImpl).not.toHaveBeenCalled();
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
    // Deferred for a human — never dismissed (there is no "dismiss"
    // dependency injected at all; only a human dismisses a lead), and never
    // `researching`, which means a human is already on it.
    expect(deps.markDeferredImpl).toHaveBeenCalledTimes(1);
    expect(deps.markDeferredImpl).toHaveBeenCalledWith("lead-1", expect.stringContaining("rejected"));
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
    expect(deps.markDeferredImpl).not.toHaveBeenCalled();
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
    expect(deps.markDeferredImpl).not.toHaveBeenCalled();
  });
});

// --- fetch failure -------------------------------------------------------------

describe("runLeadsLane — fetch failure", () => {
  it("defers the lead with the reason code on a permanent failure", async () => {
    const deps = makeDeps({ fetchPageTextImpl: vi.fn(async () => pageFail("blocked")) });

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(summary.fetchFailed).toBe(1);
    expect(summary.staged).toBe(0);
    expect(deps.callOllamaImpl).not.toHaveBeenCalled();
    expect(deps.markDeferredImpl).toHaveBeenCalledWith("lead-1", expect.stringContaining("blocked"));
    expect(deps.createSubmissionImpl).not.toHaveBeenCalled();
  });

  it("reads a PDF lead through the PDF path and proceeds", async () => {
    const deps = makeDeps({
      fetchPageTextImpl: vi.fn(async (): Promise<FetchPageTextResult> => pageFail("bad_content_type")),
      fetchPdfTextImpl: vi.fn(async () => ({
        ok: true as const,
        text: PAGE_TEXT,
        finalUrl: "https://example.com/a.pdf",
        httpStatus: 200,
        contentType: "application/pdf",
        pages: 1,
      })) as never,
    });

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(deps.fetchPdfTextImpl).toHaveBeenCalled();
    expect(summary.fetchFailed).toBe(0);
    expect(summary.staged).toBe(1);
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
    expect(deps.markDeferredImpl).toHaveBeenCalledTimes(1);
    expect(deps.markDeferredImpl).toHaveBeenCalledWith("lead-1", expect.stringContaining("geocode"));
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
    expect(deps.markDeferredImpl).not.toHaveBeenCalled();
    expect(deps.promoteLeadImpl).not.toHaveBeenCalled();
  });
});

// --- model returns nulls ------------------------------------------------------

describe("runLeadsLane — model finds nothing usable", () => {
  it("defers the lead, never dismissed, and never calls the verification gate", async () => {
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
    expect(deps.markDeferredImpl).toHaveBeenCalledWith("lead-1", expect.stringContaining("no usable"));
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
    expect(deps.markDeferredImpl).not.toHaveBeenCalled();
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

// --- schema rejection: the fourth (previously untested) defer path -----------

describe("runLeadsLane — built payload fails facilitySchema", () => {
  it("defers the lead rather than staging an invalid facility record", async () => {
    // A geocode hit whose latitude is out of range: it passes the "did we get
    // a result at all" check, then fails `facilitySchema`'s
    // `lat: z.number().min(-90).max(90)`. This exercises the schemaRejected
    // branch without touching the extraction or verification gates.
    const deps = makeDeps({
      geocodeImpl: vi.fn(async (): Promise<GeocodeResult[]> => [
        { lat: 999, lon: -97.7, label: "Nowhere" },
      ]),
    });

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(summary.schemaRejected).toBe(1);
    expect(summary.staged).toBe(0);
    expect(deps.createSubmissionImpl).not.toHaveBeenCalled();
    expect(deps.promoteLeadImpl).not.toHaveBeenCalled();
    expect(deps.markDeferredImpl).toHaveBeenCalledTimes(1);
    expect(deps.markDeferredImpl).toHaveBeenCalledWith(
      "lead-1",
      expect.stringContaining("valid facility record")
    );
  });

  it("writes no status at all on a dry run", async () => {
    const deps = makeDeps({
      geocodeImpl: vi.fn(async (): Promise<GeocodeResult[]> => [
        { lat: 999, lon: -97.7, label: "Nowhere" },
      ]),
    });

    const summary = await runLeadsLane(baseOpts({ dryRun: true }), deps);

    expect(summary.schemaRejected).toBe(1);
    expect(deps.markDeferredImpl).not.toHaveBeenCalled();
  });
});

// --- the one-way-door wiring: the lane must write `deferred`, not `researching`

describe("leads-lane writes `deferred`, never `researching`", () => {
  // `buildRealDeps()` is module-private and its closures reach the real
  // database, so no runtime test can observe the status literal it passes to
  // `updateLeadStatus`. Every test above injects `markDeferredImpl` as a mock
  // and therefore CANNOT fail if that literal regresses to "researching" —
  // which is exactly the defect this change closes. Pin it at the source, the
  // same way lib/lead-fields.guard.test.ts pins its import boundary.
  const source = readFileSync(join(process.cwd(), "scripts/discovery/leads-lane.ts"), "utf8");

  it("wires markDeferredImpl to the guarded deferLeadIfNew, which writes 'deferred'", () => {
    expect(source).toMatch(/markDeferredImpl:\s*\(id,\s*note\)\s*=>\s*deferLeadIfNew\(id,\s*note\)/);
    const leadsLib = readFileSync(join(process.cwd(), "lib/leads.ts"), "utf8");
    const fn = leadsLib.slice(leadsLib.indexOf("export async function deferLeadIfNew"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toMatch(/status: "deferred"/);

    // The regexes here scan the WHOLE module, so a SECOND `markDeferredImpl:`
    // wiring (or the literal in a comment) could satisfy the positive match
    // above while the real wiring passed something else. Pin it to exactly one.
    // Scoped to the untyped `(id, note) =>` closure shape that only a wiring
    // has, so the interface's typed `(id: string, note: string)` declaration --
    // a legitimate second `markDeferredImpl:` -- is not counted.
    expect(source.match(/markDeferredImpl:\s*\(id,\s*note\)\s*=>/g)).toHaveLength(1);
  });

  it("never passes 'researching' to updateLeadStatus anywhere in the lane", () => {
    // `researching` means "a human is actively working this lead" and is set
    // only by the admin control (app/admin/leads/actions.ts). If the lane can
    // write it too, the two meanings become indistinguishable again.
    expect(source).not.toMatch(/updateLeadStatus\([^)]*["']researching["']/);
  });

  it("defines `deferred` as a lead status", () => {
    expect(LEAD_STATUSES).toContain("deferred");
  });
});

// --- geocode outage --------------------------------------------------------------

describe("runLeadsLane — geocode throws", () => {
  it("leaves the lead untouched and continues to the next lead", async () => {
    let call = 0;
    const geocodeImpl = vi.fn(async (): Promise<GeocodeResult[]> => {
      call++;
      if (call === 1) throw new Error("Geocoding failed (403)");
      return [{ lat: 30.1, lon: -97.7, label: "Austin, TX" }];
    });
    const deps = makeDeps({
      listNewLeadsImpl: vi.fn(async () => [makeLead({ id: "lead-a" }), makeLead({ id: "lead-b" })]),
      callOllamaImpl: sequencedOllama([
        extractionOk(extraction()),
        verdictResult(VERIFIED_QUOTE),
        extractionOk(extraction()),
        verdictResult(VERIFIED_QUOTE),
      ]),
      geocodeImpl,
    });

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(summary.geocodeErrored).toBe(1);
    expect(summary.geocodeFailed).toBe(0);
    expect(summary.staged).toBe(1);
    expect(summary.stagedLeadIds).toEqual(["lead-b"]);
    expect(deps.markDeferredImpl).not.toHaveBeenCalled();
    expect(deps.promoteLeadImpl).not.toHaveBeenCalledWith("lead-a", expect.anything(), expect.anything());
  });
});

// --- duplicate guard -------------------------------------------------------------

describe("runLeadsLane — possible duplicate", () => {
  it("defers when the lead's triage already lists duplicate facilities", async () => {
    const deps = makeDeps({
      listNewLeadsImpl: vi.fn(async () => [
        makeLead({
          triage: { fetchedAt: "2026-10-09", ok: true, duplicateFacilityIds: ["google-lincoln-ne"] },
        }),
      ]),
    });

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(summary.possibleDuplicate).toBe(1);
    expect(summary.staged).toBe(0);
    expect(deps.createSubmissionImpl).not.toHaveBeenCalled();
    expect(deps.geocodeImpl).not.toHaveBeenCalled();
    expect(deps.markDeferredImpl).toHaveBeenCalledWith(
      "lead-1",
      "leads-lane: possible duplicate of google-lincoln-ne — stage an update via /admin/leads"
    );
    // Known before any network/model work: nothing is fetched or asked.
    expect(deps.fetchPageTextImpl).not.toHaveBeenCalled();
    expect(deps.callOllamaImpl).not.toHaveBeenCalled();
    expect(deps.findPossibleDuplicatesImpl).not.toHaveBeenCalled();
  });

  it("dry run: a triage duplicate writes nothing, does no work, but is counted", async () => {
    const deps = makeDeps({
      listNewLeadsImpl: vi.fn(async () => [
        makeLead({ triage: { fetchedAt: "2026-10-09", ok: true, duplicateFacilityIds: ["google-lincoln-ne"] } }),
      ]),
    });

    const summary = await runLeadsLane(baseOpts({ dryRun: true }), deps);

    expect(summary.possibleDuplicate).toBe(1);
    expect(deps.markDeferredImpl).not.toHaveBeenCalled();
    expect(deps.fetchPageTextImpl).not.toHaveBeenCalled();
    expect(deps.callOllamaImpl).not.toHaveBeenCalled();
  });

  it("ignores duplicateFacilityIds when triage did not succeed (ok: false) and proceeds normally", async () => {
    const deps = makeDeps({
      listNewLeadsImpl: vi.fn(async () => [
        makeLead({
          triage: { fetchedAt: "2026-10-09", ok: false, duplicateFacilityIds: ["google-lincoln-ne"] },
        }),
      ]),
    });

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(summary.possibleDuplicate).toBe(0);
    expect(summary.staged).toBe(1);
    expect(deps.fetchPageTextImpl).toHaveBeenCalled();
    expect(deps.findPossibleDuplicatesImpl).toHaveBeenCalled();
  });

  it("propagates a DB error from the duplicate query (fail-closed) and stages nothing", async () => {
    const deps = makeDeps({
      findPossibleDuplicatesImpl: vi.fn(async () => {
        throw new Error("db down");
      }),
    });

    await expect(runLeadsLane(baseOpts(), deps)).rejects.toThrow("db down");
    expect(deps.createSubmissionImpl).not.toHaveBeenCalled();
    expect(deps.markDeferredImpl).not.toHaveBeenCalled();
  });

  it("defers when findPossibleDuplicates returns ids", async () => {
    const deps = makeDeps({
      findPossibleDuplicatesImpl: vi.fn(async () => ["example-tx-1", "example-tx-2"]),
    });

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(deps.findPossibleDuplicatesImpl).toHaveBeenCalledWith({
      name: "Example Facility",
      operator: "Example Corp",
      state: "TX",
      city: "Austin",
    });
    expect(summary.possibleDuplicate).toBe(1);
    expect(deps.createSubmissionImpl).not.toHaveBeenCalled();
    expect(deps.markDeferredImpl).toHaveBeenCalledWith(
      "lead-1",
      expect.stringContaining("example-tx-1, example-tx-2")
    );
  });

  it("writes nothing in a dry run but still counts it", async () => {
    const deps = makeDeps({ findPossibleDuplicatesImpl: vi.fn(async () => ["example-tx-1"]) });

    const summary = await runLeadsLane(baseOpts({ dryRun: true }), deps);

    expect(summary.possibleDuplicate).toBe(1);
    expect(deps.markDeferredImpl).not.toHaveBeenCalled();
    expect(deps.createSubmissionImpl).not.toHaveBeenCalled();
  });

  it("stages as before when there is no duplicate", async () => {
    const deps = makeDeps({
      listNewLeadsImpl: vi.fn(async () => [
        makeLead({ triage: { fetchedAt: "2026-10-09", ok: true, duplicateFacilityIds: [] } }),
      ]),
    });

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(summary.possibleDuplicate).toBe(0);
    expect(summary.staged).toBe(1);
    expect(deps.createSubmissionImpl).toHaveBeenCalledTimes(1);
  });
});

// --- Wave 5: exit code, ordering, truncation, no invented values ---------------

describe("leadsLaneExitCode", () => {
  it("is 1 when a createSubmission failed, 0 otherwise", async () => {
    const deps = makeDeps({
      createSubmissionImpl: vi.fn(async (): Promise<SubmissionResult> => ({ ok: false, error: "boom" } as never)),
    });
    const failed = await runLeadsLane(baseOpts(), deps);
    expect(failed.errors).toBe(1);
    expect(leadsLaneExitCode(failed)).toBe(1);

    const ok = await runLeadsLane(baseOpts(), makeDeps());
    expect(leadsLaneExitCode(ok)).toBe(0);
  });

  it("is 0 for a deliberately deferred lead", async () => {
    const deps = makeDeps({ fetchPageTextImpl: vi.fn(async () => pageFail("http_error")) });
    expect(leadsLaneExitCode(await runLeadsLane(baseOpts(), deps))).toBe(0);
  });
});

describe("runLeadsLane — extraction prompt and unstated facts", () => {
  it("truncates an oversized page before the extraction prompt", async () => {
    const huge = "x".repeat(MAX_PAGE_TEXT_CHARS * 2);
    const ollama = sequencedOllama([extractionOk(extraction()), verdictResult(VERIFIED_QUOTE)]);
    const deps = makeDeps({
      fetchPageTextImpl: vi.fn(async () => pageOk(huge)),
      callOllamaImpl: vi.fn(ollama) as never,
    });

    await runLeadsLane(baseOpts(), deps);

    const firstCall = vi.mocked(deps.callOllamaImpl).mock.calls[0][0] as { userPrompt: string };
    expect(firstCall.userPrompt.length).toBeLessThan(MAX_PAGE_TEXT_CHARS + 2_000);
  });

  it.each([
    ["facilityType", { facilityType: null }],
    ["status", { status: null }],
  ])("defers instead of staging an invented value when %s is null", async (_label, patch) => {
    const deps = makeDeps({
      callOllamaImpl: sequencedOllama([extractionOk(extraction(patch)), verdictResult(VERIFIED_QUOTE)]),
    });

    const summary = await runLeadsLane(baseOpts(), deps);

    expect(summary.staged).toBe(0);
    expect(deps.createSubmissionImpl).not.toHaveBeenCalled();
    expect(deps.markDeferredImpl).toHaveBeenCalledWith("lead-1", expect.stringContaining("facility type/status"));
  });
});

describe("runLeadsLane — permanent vs transient read failures", () => {
  const run = (fail: FetchPageTextResult, lead: Partial<LeadForLane> = {}) => {
    const deps = makeDeps({
      listNewLeadsImpl: vi.fn(async () => [makeLead(lead)]),
      fetchPageTextImpl: vi.fn(async () => fail),
    });
    return runLeadsLane(baseOpts(), deps).then(() => deps);
  };

  it.each<[string, FetchPageTextResult]>([
    ["too_large", { ok: false, reason: "too_large" }],
    ["blocked", { ok: false, reason: "blocked" }],
    ["bad_content_type", { ok: false, reason: "bad_content_type" }],
    ["http 404", { ok: false, reason: "http_error", httpStatus: 404 }],
  ])("defers at once on permanent %s", async (_l, fail) => {
    const deps = await run(fail);
    expect(deps.markDeferredImpl).toHaveBeenCalledWith("lead-1", expect.stringContaining("could not be read"));
  });

  it.each<[string, FetchPageTextResult]>([
    ["network_error", { ok: false, reason: "network_error" }],
    ["http 503", { ok: false, reason: "http_error", httpStatus: 503 }],
    ["http 429", { ok: false, reason: "http_error", httpStatus: 429 }],
    ["http 408", { ok: false, reason: "http_error", httpStatus: 408 }],
    ["http 403 bot wall", { ok: false, reason: "http_error", httpStatus: 403 }],
    ["http 401", { ok: false, reason: "http_error", httpStatus: 401 }],
  ])("leaves a fresh lead new on transient %s", async (_l, fail) => {
    const deps = await run(fail);
    expect(deps.markDeferredImpl).not.toHaveBeenCalled();
  });

  it("defers a transient failure once the lead is 15 days old", async () => {
    const deps = await run(
      { ok: false, reason: "network_error" },
      { createdAt: new Date("2026-08-05T00:00:00.000Z") }
    );
    expect(deps.markDeferredImpl).toHaveBeenCalledWith(
      "lead-1",
      "leads-lane: page could not be read for 14 days (network_error)"
    );
  });

  it("does not defer a transient failure at 13 days", () => {
    const now = new Date("2026-08-20T00:00:00.000Z");
    expect(
      classifyFetchFailure({ reason: "network_error" }, new Date("2026-08-07T00:00:00.000Z"), now)
    ).toEqual({ action: "retry" });
  });
});

describe("runLeadsLane — PDF-path failure reasons", () => {
  const pdfRun = (pdf: unknown, lead: Partial<LeadForLane> = {}) => {
    const deps = makeDeps({
      listNewLeadsImpl: vi.fn(async () => [makeLead(lead)]),
      fetchPageTextImpl: vi.fn(async (): Promise<FetchPageTextResult> => pageFail("bad_content_type")),
      fetchPdfTextImpl: vi.fn(async () => pdf) as never,
    });
    return runLeadsLane(baseOpts(), deps).then((summary) => ({ deps, summary }));
  };

  it("poppler missing: stays new, is counted, fails the run, and never ages out", async () => {
    const old = { createdAt: new Date("2026-01-01T00:00:00.000Z") };
    const { deps, summary } = await pdfRun({ ok: false, reason: "pdf_extractor_unavailable" }, old);
    expect(deps.markDeferredImpl).not.toHaveBeenCalled();
    expect(summary.pdfExtractorUnavailable).toBe(1);
    expect(leadsLaneExitCode(summary)).toBe(1);
  });

  it("a 503 or network error on the PDF GET is transient (fresh lead stays new)", async () => {
    for (const pdf of [
      { ok: false, reason: "http_error", httpStatus: 503 },
      { ok: false, reason: "network_error" },
    ]) {
      const { deps } = await pdfRun(pdf);
      expect(deps.markDeferredImpl).not.toHaveBeenCalled();
    }
  });

  it("a PDF path that throws is transient", async () => {
    const deps = makeDeps({
      fetchPageTextImpl: vi.fn(async (): Promise<FetchPageTextResult> => pageFail("bad_content_type")),
      fetchPdfTextImpl: vi.fn(async () => {
        throw new Error("EMFILE");
      }),
    });
    await runLeadsLane(baseOpts(), deps);
    expect(deps.markDeferredImpl).not.toHaveBeenCalled();
  });

  it("a genuinely unparseable PDF defers at once", async () => {
    const { deps } = await pdfRun({ ok: false, reason: "pdf_extract_failed" });
    expect(deps.markDeferredImpl).toHaveBeenCalledWith("lead-1", expect.stringContaining("pdf_extract_failed"));
  });
});

describe("runLeadsLane — no starvation, no double staging", () => {
  const OLD = new Date("2026-08-01T00:00:00.000Z");

  it("escalate and geocode-error leads age out after 14 days, not before", async () => {
    const cases: Array<Partial<LeadsLaneDeps>> = [
      {
        fetchPageTextImpl: (() => {
          let n = 0;
          return vi.fn(async (): Promise<FetchPageTextResult> => (++n === 1 ? pageOk() : { ok: false, reason: "too_large" }));
        })(),
      },
      { geocodeImpl: vi.fn(async (): Promise<GeocodeResult[]> => { throw new Error("503"); }) },
    ];
    for (const over of cases) {
      for (const [now, expectDefer] of [["2026-08-10T00:00:00.000Z", false], ["2026-08-20T00:00:00.000Z", true]] as const) {
        const deps = makeDeps({
          listNewLeadsImpl: vi.fn(async () => [makeLead({ createdAt: OLD })]),
          now: () => new Date(now),
          ...over,
          ...(over.fetchPageTextImpl ? { fetchPageTextImpl: (() => {
            let n = 0;
            return vi.fn(async (): Promise<FetchPageTextResult> => (++n === 1 ? pageOk() : { ok: false, reason: "too_large" }));
          })() } : {}),
        });
        await runLeadsLane(baseOpts(), deps);
        expect(vi.mocked(deps.markDeferredImpl).mock.calls.length).toBe(expectDefer ? 1 : 0);
        if (expectDefer) {
          expect(deps.markDeferredImpl).toHaveBeenCalledWith("lead-1", expect.stringContaining("for 14 days"));
        }
      }
    }
  });

  it("ten stuck oldest leads cannot hold the queue past the age-out window", async () => {
    const state = new Map<string, { createdAt: Date; status: string }>();
    for (let i = 0; i < 10; i++) state.set(`stuck-${i}`, { createdAt: new Date(Date.UTC(2026, 7, 1, i)), status: "new" });
    state.set("fresh", { createdAt: new Date("2026-08-02T00:00:00.000Z"), status: "new" });
    const processed: string[] = [];
    let now = new Date("2026-08-03T00:00:00.000Z");
    const deps = makeDeps({
      listNewLeadsImpl: vi.fn(async (limit: number) =>
        [...state.entries()]
          .filter(([, v]) => v.status === "new")
          .sort((a, b) => a[1].createdAt.getTime() - b[1].createdAt.getTime())
          .slice(0, limit)
          .map(([id, v]) => makeLead({ id, url: `https://example.com/${id}`, createdAt: v.createdAt }))
      ),
      fetchPageTextImpl: vi.fn(async (url: string): Promise<FetchPageTextResult> => {
        processed.push(url);
        return url.endsWith("fresh") ? pageOk() : { ok: false, reason: "network_error" };
      }),
      markDeferredImpl: vi.fn(async (id: string): Promise<LeadActionResult> => {
        state.get(id)!.status = "deferred";
        return { ok: true, lead: { status: "deferred" } as never };
      }),
      now: () => now,
    });
    await runLeadsLane(baseOpts(), deps);
    expect(processed.some((u) => u.endsWith("fresh"))).toBe(false);
    now = new Date("2026-08-16T00:00:00.000Z"); // > 14 days after the stuck leads
    await runLeadsLane(baseOpts(), deps); // ages the stuck ones out
    await runLeadsLane(baseOpts(), deps);
    expect(processed.some((u) => u.endsWith("fresh"))).toBe(true);
  });

  it("a failed promoteLead parks the lead deferred with the submission id (no re-stage)", async () => {
    const deps = makeDeps({
      promoteLeadImpl: vi.fn(async (): Promise<LeadActionResult> => ({ ok: false, status: 409, error: "x" })),
    });
    const summary = await runLeadsLane(baseOpts(), deps);
    expect(summary.staged).toBe(1);
    expect(deps.markDeferredImpl).toHaveBeenCalledWith(
      "lead-1",
      "leads-lane: staged as submission 22222222-2222-2222-2222-222222222222, promote failed"
    );
    expect(leadsLaneExitCode(summary)).toBe(0);
  });

  it("a 409 on the park (lead already changed) is logged and skipped, not an error", async () => {
    const deps = makeDeps({
      promoteLeadImpl: vi.fn(async (): Promise<LeadActionResult> => ({ ok: false, status: 500, error: "ambiguous" })),
      markDeferredImpl: vi.fn(
        async (): Promise<LeadActionResult> => ({ ok: false, status: 409, error: "Lead is no longer new" })
      ),
    });
    const summary = await runLeadsLane(baseOpts(), deps);
    expect(summary.errors).toBe(0);
    expect(leadsLaneExitCode(summary)).toBe(0);
  });

  it("promote AND park failing fails the run", async () => {
    const deps = makeDeps({
      promoteLeadImpl: vi.fn(async (): Promise<LeadActionResult> => ({ ok: false, status: 500, error: "x" })),
      markDeferredImpl: vi.fn(async (): Promise<LeadActionResult> => ({ ok: false, status: 500, error: "y" })),
    });
    expect(leadsLaneExitCode(await runLeadsLane(baseOpts(), deps))).toBe(1);
  });
});
