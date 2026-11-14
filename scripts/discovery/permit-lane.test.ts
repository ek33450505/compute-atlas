import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { Facility } from "../../lib/schema";
import { looksLikeAddress } from "./tceq-names";
import {
  createTceqSession,
  fetchTxr15Summary,
  parseResultsPage,
  parseSummaryPage,
  TceqNarrowSearchError,
  TceqRequestError,
  type TceqRow,
  type TceqSummary,
} from "./tceq-client";
import {
  buildKnownOperators,
  chunkWindow,
  receivingWaterText,
  texasToday,
  buildNote,
  matchRow,
  normalizeOperatorName,
  NOTE_MAX,
  parsePermitLaneArgs,
  permitLaneExitCode,
  PermitLaneArgError,
  runPermitLane,
  type PermitLaneDeps,
  type PermitLaneOptions,
} from "./permit-lane";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => readFileSync(path.join(here, "tceq-fixtures", n), "utf8");
const results = parseResultsPage(fixture("results-page.html"));
const BLACK_URL = results.rows[0].summaryUrl;
const blackSummary = parseSummaryPage(fixture("summary-TXR1551YV.html"), BLACK_URL);

const NOW = new Date("2026-11-13T12:00:00Z");
const opts = (over: Partial<PermitLaneOptions> = {}): PermitLaneOptions => ({
  limit: 5,
  lookbackDays: 120,
  dryRun: false,
  runId: "t",
  ...over,
});

function facility(over: Record<string, unknown>): Facility {
  return { id: "fac-1", facilityType: "data_center", operator: "Someone", sources: [{ url: "https://example.com" }], ...over } as unknown as Facility;
}

const BLACK_FAC = facility({
  id: "blackchamber-project-longhorn-cedar-creek-tx",
  operator: "Black Chamber Partners (BlackChamber Group affiliate)",
});

function row(over: Partial<TceqRow>): TceqRow {
  return {
    permitNumber: "TXR1500AA",
    summaryUrl: "https://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.permit_summary&lgl_ident_txt=TXR1500AA&lgl_id=1",
    siteName: "SOME SITE",
    permittee: "Some Builder LLC",
    ...over,
  };
}

function makeDeps(over: Partial<PermitLaneDeps> & { rows?: TceqRow[]; facilities?: Facility[] } = {}) {
  const created: { url: string; note: string }[] = [];
  const logs: string[] = [];
  const deps: PermitLaneDeps = {
    loadFacilitiesImpl: async () => over.facilities ?? [BLACK_FAC],
    // The fixture rows come back on the first search call only, so a chunked window does not repeat them.
    searchImpl: vi.fn(
      (() => {
        let first = true;
        return async () => {
          const rows = first ? (over.rows ?? results.rows) : [];
          first = false;
          return { reported: rows.length, rows };
        };
      })(),
    ),
    // Echo the row's site name through the summary so the summary-side site-name gate is exercised.
    fetchSummaryImpl: vi.fn(async (url: string): Promise<TceqSummary> => {
      if (url === BLACK_URL) return blackSummary;
      const r = (over.rows ?? results.rows).find((x) => x.summaryUrl === url);
      return { permitNumber: r?.permitNumber ?? "X", siteName: r?.siteName, county: "HARRIS" };
    }),
    listLeadUrlsImpl: async () => [],
    createLeadImpl: async (input) => {
      created.push(input);
      return { ok: true, id: `lead-${created.length}` };
    },
    now: () => NOW,
    log: (m) => logs.push(m),
    ...over,
  };
  delete (deps as Partial<typeof over>).rows;
  delete (deps as Partial<typeof over>).facilities;
  return { deps, created, logs };
}

describe("normalizeOperatorName", () => {
  it("makes the parenthetical and LLC variants equal", () => {
    expect(normalizeOperatorName("Black Chamber Partners (BlackChamber Group affiliate)")).toBe("black chamber partners");
    expect(normalizeOperatorName("Black Chamber Partners, LLC")).toBe("black chamber partners");
    expect(normalizeOperatorName("Acme & Sons, L.L.C.")).toBe("acme and sons");
    expect(normalizeOperatorName("Acme Co Inc")).toBe("acme");
  });
  it("keeps words like partners and group, and ignores short keys", () => {
    expect(normalizeOperatorName("Franklin Partners")).toBe("franklin partners");
    expect(normalizeOperatorName("Foo Group Holdings LLC")).toBe("foo group holdings");
    expect(normalizeOperatorName("ABC LLC")).toBe("");
  });
});

describe("matchRow", () => {
  const known = buildKnownOperators([BLACK_FAC]);
  it("matches each rule", () => {
    expect(matchRow(row({ siteName: "Hyperscale Campus" }), known)?.rules).toEqual(["keyword"]);
    expect(matchRow(row({ permittee: "Bitcoin Ranch LLC" }), known)?.rules).toEqual(["keyword"]);
    expect(matchRow(row({ siteName: "Datacenter One" }), known)?.rules).toEqual(["keyword"]);
    expect(matchRow(row({ sic: "7374" }), known)?.rules).toEqual(["sic7374"]);
    const op = matchRow(results.rows[0], known);
    expect(op?.rules).toEqual(["knownOperator"]);
    expect(op?.operatorFacilityIds).toEqual([BLACK_FAC.id]);
  });
  it("does not match mining, or a prefix of a known operator", () => {
    expect(matchRow(row({ siteName: "Sand and Gravel Mining Pit" }), known)).toBeNull();
    const k = buildKnownOperators([facility({ id: "f", operator: "Franklin Partners" })]);
    expect(matchRow(row({ permittee: "Jane Q Example" }), k)).toBeNull();
    expect(matchRow(row({ permittee: "Franklin Partners Development LLC" }), k)).toBeNull();
  });
  it("only learns operators from data_center and crypto_mining facilities", () => {
    const k = buildKnownOperators([facility({ id: "p", facilityType: "power_generation", operator: "Gridco Energy" })]);
    expect(matchRow(row({ permittee: "Gridco Energy LLC" }), k)).toBeNull();
  });
  it("learns owner entities from parties", () => {
    const k = buildKnownOperators([facility({ operator: "Unrelated", parties: { ownerEntity: [{ name: "Project Foo LLC", sourceIndex: 0 }] } })]);
    expect(matchRow(row({ permittee: "Project Foo, L.L.C." }), k)?.rules).toEqual(["knownOperator"]);
  });
});

describe("runPermitLane", () => {
  it("inserts one lead per matched permit from the real fixtures", async () => {
    const { deps, created } = makeDeps();
    const s = await runPermitLane(opts(), deps);
    expect(s.window).toEqual({ start: "2026-07-17", end: "2026-11-13" });
    expect(s.chunks).toBe(4);
    expect(s).toMatchObject({ reported: 6, rawRows: 6, distinctPermits: 4, matched: 2, inserted: 2, failures: 0 });
    expect(s.byRule).toEqual({ keyword: 1, sic7374: 0, knownOperator: 1 });
    expect(created.map((c) => c.url)).toEqual([results.rows[2].summaryUrl, BLACK_URL].sort());
    expect(created.every((c) => c.note.length <= NOTE_MAX)).toBe(true);
    expect(permitLaneExitCode(s)).toBe(0);
    expect(deps.searchImpl).toHaveBeenNthCalledWith(1, { permitStatus: "ACTIVE", startDate: "2026-07-17", endDate: "2026-08-15" });
    expect(deps.searchImpl).toHaveBeenNthCalledWith(4, { permitStatus: "ACTIVE", startDate: "2026-10-15", endDate: "2026-11-13" });
  });

  it("uses --since over the lookback", async () => {
    const { deps } = makeDeps();
    const s = await runPermitLane(opts({ since: "2026-06-01" }), deps);
    expect(s.window.start).toBe("2026-06-01");
  });

  it("builds the documented note for the real summary", async () => {
    const { deps, created } = makeDeps();
    await runPermitLane(opts(), deps);
    const note = created.find((c) => c.url === BLACK_URL)!.note;
    expect(note).toContain('TXR15 construction stormwater permit TXR1551YV, site "BCG CEDAR CREEK CAMPUS", permittee Black Chamber Partners, LLC, SIC 1541; 304 acres disturbed;');
    expect(note).toContain("BRUSHY CREEK (segment 1244)");
    expect(note).toContain("Bastrop County");
    expect(note).toContain("permit location 30.057081, -97.428818");
    expect(note).toContain("Matched: known operator.");
    expect(note).toContain("Existing records with this operator: blackchamber-project-longhorn-cedar-creek-tx.");
    expect(note).not.toMatch(/@/);
    expect(note).not.toMatch(/\d{3}[\s.\-)]*\d{3}[\s.\-]*\d{4}/);
  });

  it("withholds an individual-looking permittee and site name on a SIC-only match, everywhere", async () => {
    const person = row({ permitNumber: "TXR1500PP", siteName: "EXAMPLE RANCH PAD", permittee: "Jane Q Example", sic: "7374" });
    const { deps, created, logs } = makeDeps({ rows: [person] });
    const s = await runPermitLane(opts(), deps);
    expect(s).toMatchObject({ matched: 1, inserted: 1 });
    expect(s.byRule.sic7374).toBe(1);
    const everything = JSON.stringify(s) + logs.join("\n") + created.map((c) => c.note).join("\n");
    expect(everything).not.toMatch(/Jane|Example|RANCH/i);
    expect(everything).toContain("TXR1500PP");
    expect(created[0].note).toContain("permittee withheld");
    expect(created[0].note).toContain("site name withheld");
    expect(created[0].note).not.toMatch(/permit location/);
  });

  it("shows the site name on a keyword match but still withholds the permittee", async () => {
    const r = row({ permitNumber: "TXR1500KK", siteName: "MILAM DATA CENTER", permittee: "Jane Q Example" });
    const { deps, created } = makeDeps({
      rows: [r],
      fetchSummaryImpl: async () => ({ permitNumber: "TXR1500KK", lat: 30.1, lon: -97.2 }),
    });
    await runPermitLane(opts(), deps);
    expect(created[0].note).toContain('site "MILAM DATA CENTER"');
    expect(created[0].note).toContain("permittee withheld");
    expect(created[0].note).toContain("permit location 30.100000, -97.200000");
    expect(created[0].note).not.toMatch(/Example/);
  });

  it("shows permittee and site on a known-operator match", async () => {
    const { deps, created } = makeDeps({ rows: [results.rows[0]] });
    await runPermitLane(opts(), deps);
    expect(created[0].note).toContain('site "BCG CEDAR CREEK CAMPUS", permittee Black Chamber Partners, LLC');
  });

  it("skips permits already in a lead (any status) or a facility source", async () => {
    const a = makeDeps({ listLeadUrlsImpl: async () => [`https://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.permit_summary&lgl_ident_txt=txr1551yv&x=1`] });
    const sa = await runPermitLane(opts(), a.deps);
    expect(sa).toMatchObject({ skippedDuplicate: 1, inserted: 1 });

    const withSource = facility({ id: "src", sources: [{ url: `${results.rows[2].summaryUrl}` }] });
    const b = makeDeps({ facilities: [BLACK_FAC, withSource] });
    const sb = await runPermitLane(opts(), b.deps);
    expect(sb).toMatchObject({ skippedDuplicate: 1, inserted: 1 });
    expect(b.created[0].url).toBe(BLACK_URL);
  });

  it("honors the limit", async () => {
    const rows = ["TXR1500C", "TXR1500A", "TXR1500B"].map((p) => row({ permitNumber: p, summaryUrl: `https://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.permit_summary&lgl_ident_txt=${p}`, siteName: "HYPERSCALE" }));
    const { deps, created } = makeDeps({ rows });
    const s = await runPermitLane(opts({ limit: 2 }), deps);
    expect(s).toMatchObject({ matched: 3, inserted: 2 });
    expect(created).toHaveLength(2);
  });

  it("inserts nothing on a dry run", async () => {
    const { deps, created } = makeDeps();
    const s = await runPermitLane(opts({ dryRun: true }), deps);
    expect(created).toHaveLength(0);
    expect(s.wouldInsert).toBe(2);
    expect(s.inserted).toBeUndefined();
    expect(s.leads).toHaveLength(2);
  });

  it("reports failures and keeps going", async () => {
    const f = makeDeps({
      fetchSummaryImpl: vi.fn(async (url: string) => {
        if (url === BLACK_URL) throw new Error("HTTP 500");
        return { permitNumber: "X" };
      }),
    });
    const s = await runPermitLane(opts(), f.deps);
    expect(s).toMatchObject({ failures: 1, inserted: 1, deferredAfterOutage: 0 });
    expect(permitLaneExitCode(s)).toBe(1);

    const ins = makeDeps({ createLeadImpl: async () => ({ ok: false, error: "Invalid lead (note)" }) });
    expect((await runPermitLane(opts(), ins.deps)).failures).toBe(2);

    const search = makeDeps({ searchImpl: async () => { throw new Error("form re-served"); } });
    const ss = await runPermitLane(opts(), search.deps);
    expect(ss.failures).toBe(3); // the fourth search is skipped after three in a row
    expect(permitLaneExitCode(ss)).toBe(1);
  });

  it("logs only the redacted code when an insert throws", async () => {
    const err = Object.assign(new Error("Failed query: insert ... params: secret-bound-value"), { code: "23505" });
    const { deps, logs } = makeDeps({ createLeadImpl: async () => { throw err; } });
    await runPermitLane(opts(), deps);
    expect(logs.join("\n")).toContain("23505");
    expect(logs.join("\n")).not.toContain("secret-bound-value");
  });

  it("fails closed when the facility read throws", async () => {
    const { deps } = makeDeps({ loadFacilitiesImpl: async () => { throw new Error("db down"); } });
    await expect(runPermitLane(opts(), deps)).rejects.toThrow("db down");
  });
});

describe("window end is today in Texas", () => {
  it("texasToday follows America/Chicago across midnight UTC and in summer time", () => {
    expect(texasToday(new Date("2026-11-14T00:30:00Z"))).toBe("2026-11-13");
    expect(texasToday(new Date("2026-11-14T06:00:00Z"))).toBe("2026-11-14");
    expect(texasToday(new Date("2026-07-01T04:30:00Z"))).toBe("2026-06-30");
  });
  it("runPermitLane ends the window on the Texas date at 00:30 UTC", async () => {
    const calls: string[] = [];
    const { deps } = makeDeps({
      searchImpl: async (c) => {
        calls.push(`${c.startDate}..${c.endDate}`);
        return { reported: 0, rows: [] };
      },
      now: () => new Date("2026-11-14T00:30:00Z"),
    });
    const s = await runPermitLane(opts({ lookbackDays: 30 }), deps);
    expect(s.window).toEqual({ start: "2026-10-15", end: "2026-11-13" });
    expect(calls).toEqual(["2026-10-15..2026-11-13"]);
  });
  it("--since is judged against the Texas date", () => {
    expect(() => parsePermitLaneArgs(["--since=2026-11-14"], () => new Date("2026-11-14T00:30:00Z"))).toThrow(PermitLaneArgError);
    expect(parsePermitLaneArgs(["--since=2026-11-13"], () => new Date("2026-11-14T00:30:00Z")).since).toBe("2026-11-13");
  });
});

describe("candidate rotation, skipped-search log and dropped rows", () => {
  const five = ["TXR1500A1", "TXR1500A2", "TXR1500A3", "TXR1500A4", "TXR1500A5"].map((p) => row({ permitNumber: p, siteName: "HYPERSCALE" }));
  const firstFiled = async (iso: string) => {
    const { deps, created } = makeDeps({ rows: five, now: () => new Date(`${iso}T18:00:00Z`) });
    await runPermitLane(opts({ limit: 1 }), deps);
    return created[0].note.match(/permit (TXR\w+)/)![1];
  };

  it("starts at a different candidate on different dates and is deterministic for one date", async () => {
    const a = await firstFiled("2026-11-13");
    expect(await firstFiled("2026-11-13")).toBe(a);
    const seen = new Set([a, await firstFiled("2026-11-14"), await firstFiled("2026-11-15")]);
    expect(seen.size).toBe(3);
  });

  it("walks every candidate once, in rotated permit-number order", async () => {
    const { deps, created } = makeDeps({ rows: five });
    await runPermitLane(opts({ limit: 5 }), deps);
    const order = created.map((c) => c.note.match(/permit (TXR\w+)/)![1]);
    expect([...order].sort()).toEqual(five.map((r) => r.permitNumber));
    const start = order.indexOf("TXR1500A1");
    expect(order.slice(start).concat(order.slice(0, start))).toEqual(five.map((r) => r.permitNumber));
  });

  it("logs 'remaining searches skipped' only when a search was actually skipped", async () => {
    const fail3 = makeDeps({ searchImpl: async () => { throw new TceqRequestError("http", "x", 503); } });
    await runPermitLane(opts(), fail3.deps);
    expect(fail3.logs.join("\n")).toContain("remaining searches skipped");
    // exactly three failures with nothing left to skip: a 90-day window is three chunks
    const exact = makeDeps({ searchImpl: async () => { throw new TceqRequestError("http", "x", 503); } });
    await runPermitLane(opts({ lookbackDays: 90 }), exact.deps);
    expect(exact.logs.join("\n")).not.toContain("remaining searches skipped");
  });

  it("adds the client's droppedRows to the summary", async () => {
    const { deps } = makeDeps({ searchImpl: async () => ({ reported: 2, rows: [], droppedRows: 2 }) });
    expect((await runPermitLane(opts({ lookbackDays: 30 }), deps)).droppedRows).toBe(2);
  });
});

describe("chunked search", () => {
  const range = (c: { startDate?: string; endDate?: string }) => `${c.startDate}..${c.endDate}`;

  it("chunkWindow splits into consecutive non-overlapping 30-day ranges", () => {
    expect(chunkWindow("2026-07-17", "2026-11-13", 30).map((r) => `${r.start}..${r.end}`)).toEqual([
      "2026-07-17..2026-08-15",
      "2026-08-16..2026-09-14",
      "2026-09-15..2026-10-14",
      "2026-10-15..2026-11-13",
    ]);
    expect(chunkWindow("2026-11-13", "2026-11-13", 30)).toEqual([{ start: "2026-11-13", end: "2026-11-13" }]);
  });

  it("merges and dedupes rows across chunks", async () => {
    const dup = row({ permitNumber: "TXR1500DD", siteName: "HYPERSCALE" });
    const { deps } = makeDeps({ searchImpl: async () => ({ reported: 1, rows: [dup] }) });
    const s = await runPermitLane(opts({ since: "2026-09-01" }), deps);
    expect(s.chunks).toBe(3);
    expect(s).toMatchObject({ reported: 3, rawRows: 3, distinctPermits: 1, inserted: 1 });
  });

  it("halves a chunk TCEQ asks to narrow, down to a counted failure at one day", async () => {
    const calls: string[] = [];
    const { deps } = makeDeps({
      searchImpl: async (c) => {
        calls.push(range(c));
        if (range(c) === "2026-11-10..2026-11-13") throw new TceqNarrowSearchError(9999, 200, 60);
        return { reported: 0, rows: [] };
      },
    });
    const s = await runPermitLane(opts({ since: "2026-11-10" }), deps);
    expect(calls).toEqual(["2026-11-10..2026-11-13", "2026-11-10..2026-11-11", "2026-11-12..2026-11-13"]);
    expect(s.failures).toBe(0);

    const bad = makeDeps({
      searchImpl: async (c) => {
        if (c.startDate === "2026-11-13") throw new TceqNarrowSearchError(9999, 200, 60);
        return { reported: 0, rows: [] };
      },
    });
    const s2 = await runPermitLane(opts({ since: "2026-11-13" }), bad.deps);
    expect(s2.failures).toBe(1);
    expect(permitLaneExitCode(s2)).toBe(1);
  });

  it("keeps searching other chunks after a chunk fails, and still files leads", async () => {
    let n = 0;
    const { deps, created } = makeDeps({
      searchImpl: async () => {
        n++;
        if (n === 1) throw new Error("HTTP 500");
        return n === 2 ? { reported: 1, rows: [row({ siteName: "HYPERSCALE" })] } : { reported: 0, rows: [] };
      },
    });
    const s = await runPermitLane(opts(), deps);
    expect(s.failures).toBe(1);
    expect(created).toHaveLength(1);
  });
});

describe("per-permit failure handling", () => {
  const kw = row({ permitNumber: "TXR1500FF", siteName: "HYPERSCALE" });
  const withRows = (over: Partial<PermitLaneDeps>) => makeDeps({ rows: [kw], ...over });

  // The REAL client path: createTceqSession + fetchTxr15Summary over a stubbed fetch.
  const viaClient = (f: typeof fetch, timeoutMs = 50): Partial<PermitLaneDeps> => ({
    fetchSummaryImpl: (url) => fetchTxr15Summary(createTceqSession({ fetch: f, rateGate: async () => {}, timeoutMs }), url),
  });
  const respond = (status: number, body = "x") => (async () => new Response(body, { status })) as unknown as typeof fetch;
  const MINIMAL =
    "TCEQ permit lane: TXR15 construction stormwater permit TXR1500FF. Matched: data-center or crypto keyword. TCEQ summary page unreadable; open the link.";

  it("a 404 or 410 is permanent: files a minimal note and counts it unreadable", async () => {
    for (const status of [404, 410]) {
      const { deps, created } = withRows(viaClient(respond(status)));
      const s = await runPermitLane(opts(), deps);
      expect(s, String(status)).toMatchObject({ failures: 0, summaryUnreadable: 1, inserted: 1 });
      expect(created[0].note).toBe(MINIMAL);
    }
  });

  it("an unparseable page and a redirect are transient: nothing is filed", async () => {
    for (const f of [respond(200, "<html>challenge</html>"), respond(302)]) {
      const { deps, created } = withRows(viaClient(f));
      const s = await runPermitLane(opts(), deps);
      expect(s).toMatchObject({ failures: 1, summaryUnreadable: 0 });
      expect(created).toHaveLength(0);
    }
  });

  it("a 500, a timeout and a network error are transient failures that file nothing", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const netErr = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    for (const f of [respond(500), respond(429), respond(403), respond(401), hang, netErr]) {
      const { deps, created } = withRows(viaClient(f, 20));
      const s = await runPermitLane(opts(), deps);
      expect(s).toMatchObject({ failures: 1, summaryUnreadable: 0 });
      expect(created).toHaveLength(0);
      expect(permitLaneExitCode(s)).toBe(1);
    }
  });

  it("a plain (non-client) error is treated as transient", async () => {
    const { deps } = withRows({ fetchSummaryImpl: async () => { throw new Error("TCEQ request failed: HTTP 404 for /x"); } });
    expect(await runPermitLane(opts(), deps)).toMatchObject({ failures: 1, summaryUnreadable: 0 });
  });

  const rowsN = (n: number) =>
    Array.from({ length: n }, (_, i) => row({ permitNumber: `TXR1500A${i}`, siteName: "HYPERSCALE", summaryUrl: `https://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.permit_summary&lgl_ident_txt=TXR1500A${i}` }));
  const http = (status: number) => new TceqRequestError("http", `TCEQ request failed: HTTP ${status} for /x`, status);

  it("one permit that always fails transiently is skipped, and the next permit is still filed", async () => {
    const rows = rowsN(2);
    const { deps, created } = makeDeps({
      rows,
      fetchSummaryImpl: async (url) => {
        if (url.includes("TXR1500A0")) throw http(403);
        return { permitNumber: "TXR1500A1", siteName: "HYPERSCALE" };
      },
    });
    const s = await runPermitLane(opts(), deps);
    expect(s).toMatchObject({ failures: 1, inserted: 1, deferredAfterOutage: 0 });
    expect(created[0].url).toContain("TXR1500A1");
    expect(permitLaneExitCode(s)).toBe(1);
  });

  it("three consecutive transient failures stop the run; deferred = min(remaining, limit - filed)", async () => {
    const fetchSummaryImpl = vi.fn(async () => { throw http(503); });
    const a = makeDeps({ rows: rowsN(8), fetchSummaryImpl });
    const s = await runPermitLane(opts({ limit: 4 }), a.deps);
    expect(fetchSummaryImpl).toHaveBeenCalledTimes(3);
    expect(s).toMatchObject({ failures: 3, deferredAfterOutage: 4, inserted: 0 });

    const few = makeDeps({ rows: rowsN(4), fetchSummaryImpl: vi.fn(async () => { throw http(503); }) });
    expect(await runPermitLane(opts({ limit: 50 }), few.deps)).toMatchObject({ failures: 3, deferredAfterOutage: 1 });
  });

  it("a success resets the consecutive counter", async () => {
    let n = 0;
    const { deps, created } = makeDeps({
      rows: rowsN(6),
      fetchSummaryImpl: async () => {
        n++;
        if (n % 3 === 0) return { permitNumber: "X", siteName: "HYPERSCALE" };
        throw http(503);
      },
    });
    const s = await runPermitLane(opts(), deps);
    expect(s).toMatchObject({ failures: 4, inserted: 2, deferredAfterOutage: 0 });
    expect(created).toHaveLength(2);
  });

  it("the counter is shared with the search phase", async () => {
    let calls = 0;
    const { deps } = makeDeps({
      rows: rowsN(3),
      searchImpl: async () => {
        calls++;
        if (calls >= 3) throw http(503);
        return calls === 1 ? { reported: 3, rows: rowsN(3) } : { reported: 0, rows: [] };
      },
      fetchSummaryImpl: async () => { throw http(503); },
    });
    const s = await runPermitLane(opts(), deps);
    // the last two searches fail, then the first summary fails: three in a row, so the rest is deferred
    expect(s).toMatchObject({ failures: 3, deferredAfterOutage: 2, inserted: 0 });
  });

  it("three failed searches in a row skip the remaining searches and every summary fetch", async () => {
    const searchImpl = vi.fn(async () => { throw http(503); });
    const { deps } = makeDeps({ rows: rowsN(3), searchImpl });
    const s = await runPermitLane(opts(), deps);
    expect(searchImpl).toHaveBeenCalledTimes(3);
    expect(s.failures).toBe(3);
    expect(permitLaneExitCode(s)).toBe(1);
  });

  it("a database error on insert stops the loop with no further fetches", async () => {
    const fetchSummaryImpl = vi.fn(async () => ({ permitNumber: "X", siteName: "HYPERSCALE" }));
    const { deps } = makeDeps({ rows: rowsN(4), fetchSummaryImpl, createLeadImpl: async () => { throw new Error("db down"); } });
    const s = await runPermitLane(opts(), deps);
    expect(fetchSummaryImpl).toHaveBeenCalledTimes(1);
    expect(s).toMatchObject({ failures: 1, inserted: 0, deferredAfterOutage: 3 });
    expect(permitLaneExitCode(s)).toBe(1);
  });

  it("a permanent failure does not trigger the circuit break", async () => {
    const rows = ["TXR1500A1", "TXR1500A2"].map((p) => row({ permitNumber: p, siteName: "HYPERSCALE" }));
    const { deps } = makeDeps({ rows, ...viaClient(respond(404)) });
    expect(await runPermitLane(opts(), deps)).toMatchObject({ failures: 0, summaryUnreadable: 2, inserted: 2, deferredAfterOutage: 0 });
  });

  it("retries once with a minimal note when the full note is refused", async () => {
    const seen: string[] = [];
    const { deps } = withRows({
      createLeadImpl: async ({ note }) => {
        seen.push(note);
        return seen.length === 1 ? { ok: false, error: "Invalid lead (note)" } : { ok: true, id: "l1" };
      },
    });
    const s = await runPermitLane(opts(), deps);
    expect(s).toMatchObject({ failures: 0, inserted: 1 });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("Details omitted; open the TCEQ link.");
    expect(s.leads[0].note).toBe(seen[1]);
  });

  it("fails only when the minimal note is refused too", async () => {
    const { deps } = withRows({ createLeadImpl: async () => ({ ok: false, error: "Invalid lead (note)" }) });
    const s = await runPermitLane(opts(), deps);
    expect(s).toMatchObject({ failures: 1, inserted: 0 });
  });
});

describe("note hardening", () => {
  const kwMatch = { rules: ["keyword" as const], operatorFacilityIds: [] };
  it("prints SIC only as four digits", () => {
    expect(buildNote(row({ sic: "7374" }), { permitNumber: "X" }, kwMatch)).toContain(", SIC 7374");
    expect(buildNote(row({ sic: "7374 (call 512)" }), { permitNumber: "X" }, kwMatch)).not.toContain("SIC");
  });
  it("gates the site name on the string it prints", () => {
    const m = { rules: ["sic7374" as const], operatorFacilityIds: [] };
    const note = buildNote(row({ siteName: "DATA CENTER ONE" }), { permitNumber: "X", siteName: "JANE EXAMPLE HOME" }, m);
    expect(note).toContain("site name withheld");
    expect(note).not.toMatch(/EXAMPLE/);
  });
  it("caps county and segment at 60 characters", () => {
    const note = buildNote(row({}), { permitNumber: "X", county: "C".repeat(90), segment: "9".repeat(90), receivingWater: "river" }, kwMatch);
    expect(note).not.toContain("C".repeat(61));
    expect(note).not.toContain("9".repeat(61));
  });
  it("never leaves half a surrogate pair at a cut", () => {
    const emoji = "😀";
    const water = receivingWaterText("W".repeat(99) + emoji)!;
    expect(water).toBe(`${"W".repeat(99)}…`);
    const note = buildNote(row({ siteName: "DATA CENTER" }), { permitNumber: "X", siteName: "DATA CENTER " + "S".repeat(400) + emoji.repeat(100) }, kwMatch);
    expect(note.length).toBeLessThanOrEqual(NOTE_MAX);
    expect(note).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    const county = buildNote(row({ county: "K".repeat(59) + emoji }), { permitNumber: "X" }, kwMatch);
    expect(county).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe("address and shape guards", () => {
  const kwMatch = { rules: ["keyword" as const], operatorFacilityIds: [] };
  it("withholds a site name that starts with a digit or has a street word", () => {
    for (const n of ["SOUTH 1234 BITCOIN", "FM 1234 DATA CENTER", "HWY 79 DATA CENTER", "IH-35 DATA CENTER", "LOOP 289 DATA CENTER", "INTERSTATE 20 CRYPTO", "DATA CENTER MILE 4", "PO BOX DATA CENTER", "POBOX DATA CENTER", "5911 EXAMPLE CIRCLE DATA CENTER", "EXAMPLE LN DATA CENTER", "DATA CENTER UNIT 4", "EXAMPLE HOME DATA CENTER", "DATA CENTER Blvd"]) {
      expect(looksLikeAddress(n), n).toBe(true);
      const note = buildNote(row({}), { permitNumber: "X", siteName: n, lat: 30.1, lon: -97.2 }, kwMatch);
      expect(note, n).toContain("site name withheld");
      expect(note).not.toMatch(/EXAMPLE|permit location/);
    }
    expect(looksLikeAddress("MILAM DATA CENTER BUILDING 1")).toBe(false);
    expect(looksLikeAddress("PHASE 2 DATA CENTER")).toBe(false);
  });
  it("applies to a known operator's site too", () => {
    const note = buildNote(row({}), { permitNumber: "X", siteName: "12 EXAMPLE ROAD" }, { rules: ["knownOperator"], operatorFacilityIds: ["f"] });
    expect(note).toContain("site name withheld");
  });
  it("skips and counts rows with a malformed permit number, logging no cell content", async () => {
    const bad = row({ permitNumber: "evil permit; DROP", siteName: "HYPERSCALE" });
    const good = row({ permitNumber: "TXR1500GG", siteName: "HYPERSCALE" });
    const { deps, logs, created } = makeDeps({ rows: [bad, good] });
    const s = await runPermitLane(opts(), deps);
    expect(s).toMatchObject({ skippedBadPermit: 1, matched: 1, inserted: 1 });
    expect(created).toHaveLength(1);
    expect(logs.join("\n")).not.toMatch(/evil|DROP/);
  });
  it("clamps limit and lookback inside runPermitLane", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => row({ permitNumber: `TXR1500${String(i).padStart(2, "0")}`, siteName: "HYPERSCALE" }));
    const { deps } = makeDeps({ rows });
    const s = await runPermitLane(opts({ limit: 5000, lookbackDays: 9999 }), deps);
    expect(s.inserted).toBe(50);
    expect(s.window.start).toBe("2025-11-14");
    const since = await runPermitLane(opts({ since: "2020-01-01" }), makeDeps().deps);
    expect(since.window.start).toBe("2025-11-14");
  });
});

describe("receivingWaterText", () => {
  it("withholds contact-shaped free text", () => {
    for (const t of ["call me at (512) 555-0147", "512-555-0147", "see http://x.example", "me@x.com ditch"]) {
      expect(receivingWaterText(t), t).toBe("withheld (free text)");
    }
  });
  it("collapses whitespace and caps at 100 characters with an ellipsis", () => {
    expect(receivingWaterText("  BRUSHY   CREEK ")).toBe("BRUSHY CREEK");
    const long = receivingWaterText("W".repeat(150))!;
    expect(long).toBe(`${"W".repeat(100)}…`);
  });
  it("appears in the note", () => {
    const note = buildNote(row({ siteName: "DATA CENTER" }), { permitNumber: "X", receivingWater: "ask 512-555-0147" }, { rules: ["keyword"], operatorFacilityIds: [] });
    expect(note).toContain("receiving water withheld (free text)");
    expect(note).not.toMatch(/555/);
  });
});

describe("buildNote", () => {
  const match = { rules: ["keyword" as const], operatorFacilityIds: [] };
  it("drops optional parts in a fixed order to stay within 500 characters", () => {
    const long: TceqSummary = { ...blackSummary, siteName: "DATA CENTER " + "S".repeat(120), receivingWater: "W".repeat(150) };
    const note = buildNote(row({ siteName: "DATA CENTER", permittee: "P".repeat(120) + " LLC" }), long, { rules: ["knownOperator"], operatorFacilityIds: ["a", "b", "c", "d", "e"] });
    expect(note.length).toBeLessThanOrEqual(NOTE_MAX);
    expect(note).not.toMatch(/Existing records/);
    expect(note).toContain("Matched: known operator.");
  });
  it("lists three ids and a count of the rest", () => {
    const note = buildNote(row({}), { permitNumber: "X" }, { rules: ["knownOperator"], operatorFacilityIds: ["a", "b", "c", "d", "e"] });
    expect(note).toContain("Existing records with this operator: a, b, c and 2 more.");
  });
  it("omits email- or phone-shaped text instead of repeating it", () => {
    const note = buildNote(row({ siteName: "DATA CENTER call 512-555-0147" }), { permitNumber: "X", siteName: "DATA CENTER mail me@x.com" }, match);
    expect(note).not.toMatch(/@|555/);
  });
  it("never prints a cut-short site name: a name too long for the note is withheld, coordinates with it", () => {
    const note = buildNote(row({ permittee: "P LLC" }), { permitNumber: "X", siteName: "DATA CENTER " + "S".repeat(600), lat: 30.1, lon: -97.2 }, match);
    expect(note.length).toBeLessThanOrEqual(NOTE_MAX);
    expect(note).toContain("site name withheld (too long)");
    expect(note).not.toMatch(/SSS|DATA CENTER S|\.\.\.|permit location/);
  });
});

describe("parsePermitLaneArgs", () => {
  it("defaults and parses", () => {
    expect(parsePermitLaneArgs([], () => NOW)).toMatchObject({ limit: 5, lookbackDays: 120, dryRun: false });
    expect(parsePermitLaneArgs(["--limit=3", "--lookback-days=7", "--since=2026-06-01", "--dry-run", "--run-id=r1"], () => NOW)).toEqual({
      limit: 3,
      lookbackDays: 7,
      since: "2026-06-01",
      dryRun: true,
      runId: "r1",
    });
  });
  it("accepts the maximums", () => {
    expect(parsePermitLaneArgs(["--limit=50", "--lookback-days=365"], () => NOW)).toMatchObject({ limit: 50, lookbackDays: 365 });
  });
  it.each([["--limit=51"], ["--lookback-days=366"], ["--since=2025-01-01"], ["--limit=0"], ["--limit=-1"], ["--limit=2.5"], ["--limit=abc"], ["--lookback-days="], ["--since=2026-02-30"], ["--since=06/01/2026"], ["--since=2027-01-01"], ["--run-id=a b"], ["--bogus"]])(
    "rejects %s",
    (flag) => {
      expect(() => parsePermitLaneArgs([flag], () => NOW)).toThrow(PermitLaneArgError);
    },
  );
});
