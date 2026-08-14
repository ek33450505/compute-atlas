import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, expect, vi } from "vitest";

import {
  MIN_NUMERIC_HINT,
  REPORT_WRITE_ABORT_THRESHOLD,
  createReportWriter,
  endReportStream,
  formatSummary,
  selectCheckableFacilities,
  UNAVAILABLE_ABORT_THRESHOLD,
  isReplayable,
  latestReportName,
  makeRunId,
  numericCapacityEntries,
  parseArgs,
  readReport,
  recordKey,
  resolveResumePath,
  runCensus,
  sourceUrls,
  type CensusFacility,
  type CensusRecord,
  type CensusSummary,
  type ReportStream,
  type VerifyImpl,
} from "./census-sources";
import type { VerificationResult } from "./verify-source";

function makeFacility(overrides: Partial<CensusFacility> = {}): CensusFacility {
  return {
    id: "facility-a",
    name: "Facility A",
    sources: [{ url: "https://example.com/a" }],
    ...overrides,
  };
}

/**
 * A gate outcome: a bare verdict, or a verdict plus the `transportFailure` the
 * real gate sets when the page could not be fetched at all.
 */
type FakeOutcome =
  | VerificationResult["verdict"]
  | {
      verdict: VerificationResult["verdict"];
      transportFailure?: VerificationResult["transportFailure"];
    };

/** A 403 bot-wall, as verify-source.ts reports it: verdict `rejected`, but the
 * page was never read, so the verdict says nothing about the citation. */
const BOT_WALL: FakeOutcome = {
  verdict: "rejected",
  transportFailure: { reason: "http_error", httpStatus: 403 },
};

/** A fake gate keyed on `${url}|${hintValue ?? ""}`, defaulting to verified. */
function fakeGate(
  verdicts: Record<string, FakeOutcome>,
  fallback: FakeOutcome = "verified",
): { verify: VerifyImpl; calls: Array<{ url: string; hint?: number }> } {
  const calls: Array<{ url: string; hint?: number }> = [];
  const verify: VerifyImpl = async (url, claim) => {
    const hint = claim.numericHints?.[0]?.value;
    calls.push({ url, hint });
    const outcome = verdicts[`${url}|${hint ?? ""}`] ?? verdicts[url] ?? fallback;
    const { verdict, transportFailure } =
      typeof outcome === "string" ? { verdict: outcome, transportFailure: undefined } : outcome;
    const result: VerificationResult = { verdict, reason: `fake ${verdict}`, sourceUrl: url };
    if (transportFailure) result.transportFailure = transportFailure;
    return result;
  };
  return { verify, calls };
}

const collect = (records: CensusRecord[]) => (record: CensusRecord) => {
  records.push(record);
};

/** A pass-A line as a previous run would have written it to the JSONL report. */
function priorRecord(overrides: Partial<CensusRecord> & { verdict: CensusRecord["verdict"] }): CensusRecord {
  return {
    pass: "a",
    facilityId: "facility-a",
    facilityName: "Facility A",
    url: "https://example.com/a",
    hintLabel: "",
    reason: `prior run: ${overrides.verdict}`,
    checkedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("numericCapacityEntries", () => {
  it("keeps numeric figures at or above the minimum hint", () => {
    expect(numericCapacityEntries({ planned: 150, operational: MIN_NUMERIC_HINT })).toEqual([
      { label: "planned", value: 150 },
      { label: "operational", value: MIN_NUMERIC_HINT },
    ]);
  });

  it("skips hints below 10 — a bare '2' collides with dates and list numbers", () => {
    expect(numericCapacityEntries({ planned: 2, operational: 9.5 })).toEqual([]);
  });

  it("ignores non-numeric and missing capacity", () => {
    expect(numericCapacityEntries({ planned: "150" })).toEqual([]);
    expect(numericCapacityEntries(null)).toEqual([]);
    expect(numericCapacityEntries(undefined)).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("defaults to both passes, concurrency 5, and a run-id report path", () => {
    expect(parseArgs([], "run-1")).toEqual({
      limit: undefined,
      out: "discovery-logs/source-census-run-1.jsonl",
      outExplicit: false,
      concurrency: 5,
      resume: false,
      passes: ["a", "b"],
    });
  });

  it("parses every flag", () => {
    const argv = ["--limit=3", "--concurrency=2", "--pass=b", "--out=discovery-logs/x.jsonl", "--resume"];
    expect(parseArgs(argv, "run-1")).toEqual({
      limit: 3,
      out: "discovery-logs/x.jsonl",
      outExplicit: true,
      concurrency: 2,
      resume: true,
      passes: ["b"],
    });
  });

  it("rejects bad values", () => {
    expect(() => parseArgs(["--limit=0"], "r")).toThrow(/--limit/);
    expect(() => parseArgs(["--concurrency=-1"], "r")).toThrow(/--concurrency/);
    expect(() => parseArgs(["--pass=c"], "r")).toThrow(/--pass/);
    expect(() => parseArgs(["--nope"], "r")).toThrow(/Unknown argument/);
  });

  it("refuses to write anywhere but a .jsonl under discovery-logs/", () => {
    // The census is read-only apart from its own report; this path would have
    // truncated the live dataset before the first check ran.
    expect(() => parseArgs(["--out=data/facilities.json"], "r")).toThrow(/discovery-logs/);
    expect(() => parseArgs(["--out=../escape.jsonl"], "r")).toThrow(/discovery-logs/);
    expect(() => parseArgs(["--out=/etc/passwd"], "r")).toThrow(/discovery-logs/);
    expect(() => parseArgs(["--out=discovery-logs/report.txt"], "r")).toThrow(/\.jsonl/);
    expect(() => parseArgs(["--out=discovery-logs/"], "r")).toThrow(/discovery-logs/);
    // The legitimate shapes still pass.
    expect(parseArgs(["--out=discovery-logs/report.jsonl"], "r").out).toBe("discovery-logs/report.jsonl");
    expect(parseArgs(["--out=discovery-logs/nested/report.jsonl"], "r").out).toBe(
      "discovery-logs/nested/report.jsonl",
    );
  });
});

describe("resolveResumePath", () => {
  const options = (overrides: Partial<ReturnType<typeof parseArgs>> = {}) => ({
    ...parseArgs([], "run-1"),
    resume: true,
    ...overrides,
  });

  it("adopts the newest existing report when --out was not given", () => {
    const listed = [
      "source-census-2026-08-13T09-00-00.jsonl",
      "source-census-2026-08-13T11-30-00.jsonl",
      "source-census-2026-08-12T23-00-00.jsonl",
      "some-other-log.jsonl",
      "source-census-notes.md",
    ];
    // Not the run-id default (which names a file that cannot exist yet) — the
    // newest real report, or a resume silently discards ~55 minutes of work.
    expect(resolveResumePath(options(), () => listed)).toBe(
      path.join("discovery-logs", "source-census-2026-08-13T11-30-00.jsonl"),
    );
  });

  it("honours an explicit --out over the newest report", () => {
    const explicit = options({ out: "discovery-logs/pinned.jsonl", outExplicit: true });
    expect(resolveResumePath(explicit, () => ["source-census-2026-08-13T11-30-00.jsonl"])).toBe(
      "discovery-logs/pinned.jsonl",
    );
  });

  it("throws rather than silently restarting when there is nothing to resume", () => {
    expect(() => resolveResumePath(options(), () => [])).toThrow(/no existing/);
    expect(() => resolveResumePath(options(), () => ["unrelated.jsonl"])).toThrow(/no existing/);
  });
});

describe("latestReportName", () => {
  it("ignores non-report files and returns undefined for an empty listing", () => {
    expect(latestReportName([])).toBeUndefined();
    expect(latestReportName(["notes.md", "other.jsonl"])).toBeUndefined();
    expect(latestReportName(["source-census-a.jsonl", "source-census-b.jsonl"])).toBe("source-census-b.jsonl");
  });
});

describe("runCensus — pass A entity binding", () => {
  it("flags a rejected source and leaves verified ones alone", async () => {
    const facilities = [
      makeFacility({
        id: "aligned-dfw-03-tx",
        name: "Aligned DFW-03",
        sources: [{ url: "https://en.wikipedia.org/wiki/Oncor_Electric_Delivery" }, { url: "https://good.example/a" }],
      }),
    ];
    const { verify } = fakeGate({ "https://en.wikipedia.org/wiki/Oncor_Electric_Delivery": "rejected" });
    const records: CensusRecord[] = [];

    const summary = await runCensus(facilities, {
      verifyImpl: verify,
      passes: ["a"],
      concurrency: 1,
      onRecord: collect(records),
    });

    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0]).toMatchObject({
      pass: "a",
      facilityId: "aligned-dfw-03-tx",
      url: "https://en.wikipedia.org/wiki/Oncor_Electric_Delivery",
    });
    expect(summary.tallies).toMatchObject({ verified: 1, rejected: 1 });
    expect(records).toHaveLength(2);
  });

  it("routes a transport-failed rejection to escalations while still flagging a real one", async () => {
    // Both come back `rejected`; only one of them was actually read. A census
    // that keys on the verdict alone reports the bot-wall as a misbinding and
    // sends a maintainer to "correct" a citation that was fine.
    const facilities = [
      makeFacility({ id: "walled", name: "Walled DC", sources: [{ url: "https://www.lncompute.com/site" }] }),
      makeFacility({ id: "misbound", name: "Misbound DC", sources: [{ url: "https://en.wikipedia.org/wiki/Oncor" }] }),
    ];
    const { verify } = fakeGate({
      "https://www.lncompute.com/site": BOT_WALL,
      "https://en.wikipedia.org/wiki/Oncor": "rejected",
    });

    const summary = await runCensus(facilities, {
      verifyImpl: verify,
      passes: ["a"],
      concurrency: 1,
      onRecord: () => {},
    });

    expect(summary.findings.map((finding) => finding.facilityId)).toEqual(["misbound"]);
    expect(summary.escalations.map((escalation) => escalation.facilityId)).toEqual(["walled"]);
    // The verdict tally still records what the gate actually said.
    expect(summary.tallies.rejected).toBe(2);
  });

  it("persists transportFailure onto the report record so a resume can see it", async () => {
    const { verify } = fakeGate({}, BOT_WALL);
    const records: CensusRecord[] = [];

    await runCensus([makeFacility()], {
      verifyImpl: verify,
      passes: ["a"],
      concurrency: 1,
      onRecord: collect(records),
    });

    expect(records[0].transportFailure).toEqual({ reason: "http_error", httpStatus: 403 });
  });

  it("passes no numeric hints in pass A", async () => {
    const { verify, calls } = fakeGate({});
    await runCensus([makeFacility({ capacityMw: { planned: 150 } })], {
      verifyImpl: verify,
      passes: ["a"],
      concurrency: 1,
      onRecord: () => {},
    });
    expect(calls).toEqual([{ url: "https://example.com/a", hint: undefined }]);
  });
});

describe("runCensus — pass B capacity backing", () => {
  const facility = makeFacility({
    id: "5c-group-vultr-prime-ohio-springfield-oh",
    name: "5C Group / Vultr Data Center (Prime Ohio)",
    capacityMw: { planned: 150 },
    sources: [{ url: "https://a.example/1" }, { url: "https://b.example/2" }],
  });

  it("passes when exactly one source supports the figure, and short-circuits", async () => {
    const { verify, calls } = fakeGate({ "https://a.example/1|150": "rejected", "https://b.example/2|150": "verified" });

    const summary = await runCensus([facility], {
      verifyImpl: verify,
      passes: ["b"],
      concurrency: 1,
      onRecord: () => {},
    });

    expect(summary.findings).toEqual([]);
    expect(calls).toHaveLength(2);

    const { verify: verifyFirst, calls: firstCalls } = fakeGate({ "https://a.example/1|150": "verified" });
    await runCensus([facility], {
      verifyImpl: verifyFirst,
      passes: ["b"],
      concurrency: 1,
      onRecord: () => {},
    });
    // Short-circuited on the first supporting source.
    expect(firstCalls).toHaveLength(1);
  });

  it("flags the facility when no source supports the figure", async () => {
    const { verify } = fakeGate({}, "rejected");

    const summary = await runCensus([facility], {
      verifyImpl: verify,
      passes: ["b"],
      concurrency: 1,
      onRecord: () => {},
    });

    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0]).toMatchObject({
      pass: "b",
      facilityId: "5c-group-vultr-prime-ohio-springfield-oh",
      hintLabel: "planned",
      hintValue: 150,
    });
    expect(summary.findings[0].reason).toContain("https://a.example/1");
    expect(summary.findings[0].reason).toContain("https://b.example/2");
  });

  it("never checks a sub-10 figure, so it can never be flagged", async () => {
    const { verify, calls } = fakeGate({}, "rejected");

    const summary = await runCensus([makeFacility({ capacityMw: { planned: 2 } })], {
      verifyImpl: verify,
      passes: ["b"],
      concurrency: 1,
      onRecord: () => {},
    });

    expect(calls).toEqual([]);
    expect(summary.findings).toEqual([]);
  });

  it("does not flag a figure when its only source was unavailable", async () => {
    const single = makeFacility({
      id: "f1",
      capacityMw: { planned: 150 },
      sources: [{ url: "https://a.example/1" }],
    });
    const { verify } = fakeGate({}, "unavailable");

    const summary = await runCensus([single], {
      verifyImpl: verify,
      passes: ["b"],
      concurrency: 1,
      onRecord: () => {},
    });

    expect(summary.findings).toEqual([]);
    expect(summary.tallies.unavailable).toBe(1);
  });

  it("does not flag a figure whose only source escalated — un-ingestible is not unsupported", async () => {
    const single = makeFacility({
      id: "sec-filing-backed",
      capacityMw: { planned: 150 },
      sources: [{ url: "https://sec.example/huge-10k" }],
    });
    const { verify } = fakeGate({}, "escalate");

    const summary = await runCensus([single], {
      verifyImpl: verify,
      passes: ["b"],
      concurrency: 1,
      onRecord: () => {},
    });

    expect(summary.findings).toEqual([]);
    expect(summary.tallies.escalate).toBe(1);
  });

  it("makes no claim when every source is unreadable, mixing escalate and unavailable", async () => {
    const { verify } = fakeGate({
      "https://a.example/1|150": "escalate",
      "https://b.example/2|150": "unavailable",
    });

    const summary = await runCensus([facility], {
      verifyImpl: verify,
      passes: ["b"],
      concurrency: 1,
      onRecord: () => {},
    });

    expect(summary.findings).toEqual([]);
  });

  it("does not flag when an escalate is followed by a supporting source", async () => {
    const { verify, calls } = fakeGate({
      "https://a.example/1|150": "escalate",
      "https://b.example/2|150": "verified",
    });

    const summary = await runCensus([facility], {
      verifyImpl: verify,
      passes: ["b"],
      concurrency: 1,
      onRecord: () => {},
    });

    // The escalate neither backs nor undermines the figure; the later verified
    // source settles it, so the unit short-circuits with nothing to report.
    expect(summary.findings).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(summary.tallies).toMatchObject({ escalate: 1, verified: 1 });
  });

  it("still flags on a read-and-rejected source, disclosing the unreadable ones", async () => {
    const { verify } = fakeGate({
      "https://a.example/1|150": "escalate",
      "https://b.example/2|150": "rejected",
    });

    const summary = await runCensus([facility], {
      verifyImpl: verify,
      passes: ["b"],
      concurrency: 1,
      onRecord: () => {},
    });

    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0].unreadableSources).toBe(1);
    expect(summary.findings[0].reason).toContain("https://b.example/2");
    expect(summary.findings[0].reason).toMatch(/1 of 2 source\(s\) could not be read/);
    // The escalated source is not presented as evidence against the figure.
    expect(summary.findings[0].reason).not.toContain("https://a.example/1: fake escalate");
  });

  it("folds a transport-failed rejection into the unreadable count, not the evidence", async () => {
    const { verify } = fakeGate({
      "https://a.example/1|150": BOT_WALL,
      "https://b.example/2|150": "rejected",
    });

    const summary = await runCensus([facility], {
      verifyImpl: verify,
      passes: ["b"],
      concurrency: 1,
      onRecord: () => {},
    });

    // The genuine rejection still stands on its own.
    expect(summary.findings).toHaveLength(1);
    // Counting the bot-wall as evidence would leave this at 0 and quote both URLs.
    expect(summary.findings[0].unreadableSources).toBe(1);
    expect(summary.findings[0].reason).toContain("https://b.example/2");
    expect(summary.findings[0].reason).not.toContain("https://a.example/1: fake rejected");
    expect(summary.findings[0].reason).toMatch(/1 of 2 source\(s\) could not be read/);
  });

  it("makes no claim when every source transport-failed, and says so in `unchecked`", async () => {
    const { verify } = fakeGate({}, BOT_WALL);

    const summary = await runCensus([facility], {
      verifyImpl: verify,
      passes: ["b"],
      concurrency: 1,
      onRecord: () => {},
    });

    // Treating these as evidence would manufacture a two-source "unsupported"
    // finding against a figure nothing ever read.
    expect(summary.findings).toEqual([]);
    expect(summary.unchecked).toHaveLength(1);
    expect(summary.unchecked[0]).toMatchObject({
      pass: "b",
      facilityId: "5c-group-vultr-prime-ohio-springfield-oh",
      hintLabel: "planned",
      hintValue: 150,
      unreadableSources: 2,
    });
  });

  it("still flags a genuine rejection that carries no transportFailure", async () => {
    // Guard against over-correcting: a read-and-contradicted source is exactly
    // what this census exists to surface.
    const { verify } = fakeGate({}, "rejected");

    const summary = await runCensus([facility], {
      verifyImpl: verify,
      passes: ["b"],
      concurrency: 1,
      onRecord: () => {},
    });

    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0].unreadableSources).toBe(0);
    expect(summary.unchecked).toEqual([]);
  });

  it("reports an all-escalate unit as unchecked rather than as silently clean", async () => {
    const { verify } = fakeGate({
      "https://a.example/1|150": "escalate",
      "https://b.example/2|150": "unavailable",
    });

    const summary = await runCensus([facility], {
      verifyImpl: verify,
      passes: ["b"],
      concurrency: 1,
      onRecord: () => {},
    });

    expect(summary.findings).toEqual([]);
    expect(summary.unchecked).toHaveLength(1);
    expect(summary.unchecked[0].reason).toContain("no cited source could be read");
  });

  it("does not report a unit as unchecked once a source supports the figure", async () => {
    const { verify } = fakeGate({
      "https://a.example/1|150": "escalate",
      "https://b.example/2|150": "verified",
    });

    const summary = await runCensus([facility], {
      verifyImpl: verify,
      passes: ["b"],
      concurrency: 1,
      onRecord: () => {},
    });

    expect(summary.findings).toEqual([]);
    expect(summary.unchecked).toEqual([]);
  });
});

describe("runCensus — pass A escalations", () => {
  it("records escalates separately from findings", async () => {
    const facilities = [
      makeFacility({ id: "f1", name: "Big Filing DC", sources: [{ url: "https://sec.example/huge-10k" }] }),
      makeFacility({ id: "f2", sources: [{ url: "https://bad.example/" }] }),
    ];
    const { verify } = fakeGate({
      "https://sec.example/huge-10k": "escalate",
      "https://bad.example/": "rejected",
    });

    const summary = await runCensus(facilities, {
      verifyImpl: verify,
      passes: ["a"],
      concurrency: 1,
      onRecord: () => {},
    });

    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0].facilityId).toBe("f2");
    expect(summary.escalations).toHaveLength(1);
    expect(summary.escalations[0]).toMatchObject({ pass: "a", facilityId: "f1", url: "https://sec.example/huge-10k" });
  });

  it("surfaces escalates in their own summary section, outside the finding counts", () => {
    const summary: CensusSummary = {
      tallies: { verified: 1, rejected: 1, escalate: 1, unavailable: 0 },
      checksRun: 3,
      checksSkipped: 0,
      findings: [
        { pass: "a", facilityId: "f2", facilityName: "Facility A", url: "https://bad.example/", reason: "misbound" },
      ],
      escalations: [
        {
          pass: "a",
          facilityId: "f1",
          facilityName: "Big Filing DC",
          url: "https://sec.example/huge-10k",
          reason: "response exceeded the size cap",
        },
      ],
      unchecked: [],
      aborted: false,
    };
    const text = formatSummary(summary, 1000);

    expect(text).toContain(
      "Pass A — review candidates: the model did not recognise this facility's name on the page: 1",
    );
    expect(text).toContain("Pass A — could not check, needs a human look: 1");
    expect(text).toContain("https://sec.example/huge-10k");
    expect(text).toContain("response exceeded the size cap");
  });

  it("frames pass A output as review candidates, never as sources known to be bad", () => {
    // Measured: springfieldohio.gov's "5C Data Center FAQs" is entirely about
    // this facility, yet the gate rejects our composite name and verifies
    // "5C Data Center" — the model matches names near-literally rather than
    // resolving entities. A reader of the report must not conclude the citation
    // is wrong, and must have enough on screen to go check it.
    const summary: CensusSummary = {
      tallies: { verified: 0, rejected: 1, escalate: 0, unavailable: 0 },
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        {
          pass: "a",
          facilityId: "5c-group-vultr-prime-ohio-springfield-oh",
          facilityName: "5C Group / Vultr Data Center (Prime Ohio)",
          url: "https://springfieldohio.gov/5c-data-center-faqs/",
          reason: 'model verdict was "not_mentioned", not "supports"',
        },
      ],
      escalations: [],
      unchecked: [],
      aborted: false,
    };
    const text = formatSummary(summary, 1000);
    // Scope every assertion to the pass A findings section — the wording of the
    // other sections is not what this test is about.
    const passA = text.slice(text.indexOf("Pass A —"), text.indexOf("Pass B —"));

    expect(passA).toMatch(/review candidate/i);
    expect(passA).toMatch(/false.positive/i);
    // The measured counter-example, not an adjective.
    expect(passA).toContain("5C Data Center");

    // No phrasing here may assert the source is actually wrong.
    for (const assertsDefect of [
      /do(es)? not bind/i,
      /do(es)? not back/i,
      /misbound/i,
      /wrong facility/i,
      /(bad|bogus|invalid) (source|citation)/i,
      /unrelated/i,
    ]) {
      expect(passA).not.toMatch(assertsDefect);
    }

    // Everything a triager needs to act on one entry: id, name, url, reason.
    expect(passA).toContain("5c-group-vultr-prime-ohio-springfield-oh");
    expect(passA).toContain("5C Group / Vultr Data Center (Prime Ohio)");
    expect(passA).toContain("https://springfieldohio.gov/5c-data-center-faqs/");
    expect(passA).toContain('model verdict was "not_mentioned", not "supports"');
  });

  it("prints unchecked pass B figures separately, so a 0-finding line cannot read as clean", () => {
    const summary: CensusSummary = {
      tallies: { verified: 0, rejected: 2, escalate: 0, unavailable: 0 },
      checksRun: 2,
      checksSkipped: 0,
      findings: [],
      escalations: [],
      unchecked: [
        {
          pass: "b",
          facilityId: "walled-dc",
          facilityName: "Walled DC",
          url: "https://a.example/1 | https://b.example/2",
          hintLabel: "planned",
          hintValue: 150,
          reason: "no cited source could be read (2 of 2) — https://a.example/1: http_error (http 403)",
          unreadableSources: 2,
        },
      ],
      aborted: false,
    };
    const text = formatSummary(summary, 1000);

    expect(text).toContain("Pass B — capacity figures no cited source supports: 0");
    expect(text).toContain("Pass B — could not check, needs a human look: 1");
    expect(text).toContain("walled-dc — Walled DC (capacityMw.planned = 150)");
    expect(text).toContain("no cited source could be read");
  });
});

describe("runCensus — unavailable handling", () => {
  it("counts unavailable in its own bucket and never as a finding", async () => {
    const facilities = [
      makeFacility({ id: "f1", sources: [{ url: "https://u1.example/" }] }),
      makeFacility({ id: "f2", sources: [{ url: "https://u2.example/" }] }),
    ];
    const { verify } = fakeGate({ "https://u1.example/": "unavailable" });

    const summary = await runCensus(facilities, {
      verifyImpl: verify,
      passes: ["a"],
      concurrency: 1,
      onRecord: () => {},
    });

    expect(summary.tallies.unavailable).toBe(1);
    expect(summary.tallies.rejected).toBe(0);
    expect(summary.findings).toEqual([]);
    expect(summary.aborted).toBe(false);
  });

  it("aborts after three consecutive unavailable results", async () => {
    const facilities = Array.from({ length: 10 }, (_, i) =>
      makeFacility({ id: `f${i}`, sources: [{ url: `https://u${i}.example/` }] }),
    );
    const { verify, calls } = fakeGate({}, "unavailable");
    const records: CensusRecord[] = [];

    const summary = await runCensus(facilities, {
      verifyImpl: verify,
      passes: ["a"],
      concurrency: 1,
      onRecord: collect(records),
    });

    expect(summary.aborted).toBe(true);
    expect(summary.abortReason).toMatch(/consecutive 'unavailable'/);
    expect(calls).toHaveLength(UNAVAILABLE_ABORT_THRESHOLD);
    // Partial results are still on disk for a later --resume.
    expect(records).toHaveLength(UNAVAILABLE_ABORT_THRESHOLD);
    expect(summary.findings).toEqual([]);
  });

  it("resets the consecutive counter on any real verdict", async () => {
    const facilities = Array.from({ length: 6 }, (_, i) =>
      makeFacility({ id: `f${i}`, sources: [{ url: `https://u${i}.example/` }] }),
    );
    const { verify } = fakeGate({
      "https://u0.example/": "unavailable",
      "https://u1.example/": "unavailable",
      "https://u2.example/": "verified",
      "https://u3.example/": "unavailable",
      "https://u4.example/": "unavailable",
    });

    const summary = await runCensus(facilities, {
      verifyImpl: verify,
      passes: ["a"],
      concurrency: 1,
      onRecord: () => {},
    });

    expect(summary.aborted).toBe(false);
    expect(summary.tallies.unavailable).toBe(4);
  });
});

describe("runCensus — resume", () => {
  it("skips keys already recorded and replays their verdicts", async () => {
    const facilities = [
      makeFacility({ id: "f1", sources: [{ url: "https://one.example/" }] }),
      makeFacility({ id: "f2", sources: [{ url: "https://two.example/" }] }),
    ];
    const prior: CensusRecord[] = [
      {
        pass: "a",
        facilityId: "f1",
        facilityName: "Facility A",
        url: "https://one.example/",
        hintLabel: "",
        verdict: "rejected",
        reason: "prior run: page is about a different entity",
        checkedAt: "2026-08-13T00:00:00.000Z",
      },
    ];
    const { verify, calls } = fakeGate({});
    const records: CensusRecord[] = [];

    const summary = await runCensus(facilities, {
      verifyImpl: verify,
      passes: ["a"],
      concurrency: 1,
      onRecord: collect(records),
      priorRecords: prior,
    });

    // Only the un-recorded facility was re-checked.
    expect(calls).toEqual([{ url: "https://two.example/", hint: undefined }]);
    expect(records).toHaveLength(1);
    expect(summary.checksRun).toBe(1);
    expect(summary.checksSkipped).toBe(1);
    // The prior rejection still shows up in the summary.
    expect(summary.tallies).toMatchObject({ verified: 1, rejected: 1 });
    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0].facilityId).toBe("f1");
  });

  it("re-checks what the outage prevented but replays what completed", async () => {
    // main() tells the operator to "rerun with --resume once it is back". If an
    // `unavailable` key is replayed, that rerun makes zero gate calls and the
    // records it was supposed to fill stay empty forever.
    const facilities = [
      makeFacility({ id: "done", sources: [{ url: "https://done.example/" }] }),
      makeFacility({ id: "outage", sources: [{ url: "https://outage.example/" }] }),
      makeFacility({ id: "walled", sources: [{ url: "https://walled.example/" }] }),
      makeFacility({ id: "big", sources: [{ url: "https://big.example/" }] }),
    ];
    const prior: CensusRecord[] = [
      priorRecord({ facilityId: "done", url: "https://done.example/", verdict: "verified" }),
      priorRecord({ facilityId: "outage", url: "https://outage.example/", verdict: "unavailable" }),
      priorRecord({
        facilityId: "walled",
        url: "https://walled.example/",
        verdict: "rejected",
        transportFailure: { reason: "http_error", httpStatus: 403 },
      }),
      priorRecord({ facilityId: "big", url: "https://big.example/", verdict: "escalate" }),
    ];
    const { verify, calls } = fakeGate({});

    const summary = await runCensus(facilities, {
      verifyImpl: verify,
      passes: ["a"],
      concurrency: 1,
      onRecord: () => {},
      priorRecords: prior,
    });

    // The outage and the bot-wall are transient; the verified and the
    // (deterministic) escalate are not.
    expect(calls.map((call) => call.url)).toEqual(["https://outage.example/", "https://walled.example/"]);
    expect(summary.checksRun).toBe(2);
    expect(summary.checksSkipped).toBe(2);
  });

  it("replays a completed rejection instead of re-checking it", async () => {
    const facilities = [makeFacility({ id: "f1", sources: [{ url: "https://one.example/" }] })];
    const prior = [priorRecord({ facilityId: "f1", url: "https://one.example/", verdict: "rejected" })];
    const { verify, calls } = fakeGate({}, "verified");

    const summary = await runCensus(facilities, {
      verifyImpl: verify,
      passes: ["a"],
      concurrency: 1,
      onRecord: () => {},
      priorRecords: prior,
    });

    expect(calls).toEqual([]);
    expect(summary.findings).toHaveLength(1);
  });

  it("treats a verdict-less completed key as 'not checked', not as support", async () => {
    const facility = makeFacility({
      id: "f1",
      capacityMw: { planned: 150 },
      sources: [{ url: "https://one.example/" }],
    });
    const { verify, calls } = fakeGate({}, "rejected");

    const summary = await runCensus([facility], {
      verifyImpl: verify,
      passes: ["b"],
      concurrency: 1,
      onRecord: () => {},
      completed: new Set([recordKey("b", "f1", "https://one.example/", "planned")]),
    });

    expect(calls).toEqual([]);
    expect(summary.checksSkipped).toBe(1);
    expect(summary.findings).toEqual([]);
  });
});

describe("runCensus — a failing report write", () => {
  it("still tallies and classifies the verdict the run already has", async () => {
    // Disk-full mid-run. Writing the report BEFORE tallying discarded the
    // verdict and re-filed the check as `unavailable`: a genuinely misbound
    // source silently stopped being a finding, and the run printed a
    // clean-looking "0" it had not earned.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { verify } = fakeGate({}, "rejected");

    const summary = await runCensus([makeFacility({ id: "misbound", name: "Misbound DC" })], {
      verifyImpl: verify,
      passes: ["a"],
      concurrency: 1,
      onRecord: () => {
        throw new Error("ENOSPC: no space left on device");
      },
    });
    error.mockRestore();

    // The check happened, so its result stands.
    expect(summary.tallies).toMatchObject({ rejected: 1, unavailable: 0 });
    expect(summary.checksRun).toBe(1);
    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0].facilityId).toBe("misbound");
    // And it is NOT laundered into "we could not check".
    expect(summary.escalations).toEqual([]);
  });

  it("aborts once results stop reaching the report, rather than running on blind", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const facilities = Array.from({ length: 10 }, (_, i) =>
      makeFacility({ id: `f${i}`, sources: [{ url: `https://w${i}.example/` }] }),
    );
    const { verify, calls } = fakeGate({}, "verified");

    const summary = await runCensus(facilities, {
      verifyImpl: verify,
      passes: ["a"],
      concurrency: 1,
      onRecord: () => {
        throw new Error("ENOSPC: no space left on device");
      },
    });
    error.mockRestore();

    expect(summary.aborted).toBe(true);
    expect(summary.abortReason).toMatch(/report-write failures/);
    expect(summary.abortReason).toMatch(/ENOSPC/);
    expect(calls).toHaveLength(REPORT_WRITE_ABORT_THRESHOLD);
    // Distinct from the model-outage abort — the checker was fine here.
    expect(summary.abortReason).not.toMatch(/could not be reached/);
    expect(summary.tallies.verified).toBe(REPORT_WRITE_ABORT_THRESHOLD);
  });

  it("does not abort when a single write fails and the rest succeed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const facilities = Array.from({ length: 5 }, (_, i) =>
      makeFacility({ id: `f${i}`, sources: [{ url: `https://w${i}.example/` }] }),
    );
    const { verify } = fakeGate({}, "verified");
    let attempt = 0;

    const summary = await runCensus(facilities, {
      verifyImpl: verify,
      passes: ["a"],
      concurrency: 1,
      onRecord: () => {
        attempt += 1;
        if (attempt === 2) throw new Error("EAGAIN: transient");
      },
    });
    error.mockRestore();

    expect(summary.aborted).toBe(false);
    expect(summary.tallies.verified).toBe(5);
  });
});

describe("createReportWriter", () => {
  /** A stream that records writes and lets a test fire its 'error' event. */
  function fakeStream(): ReportStream & { writes: string[]; fail: (error: Error) => void } {
    const listeners: Array<(error: Error) => void> = [];
    const writes: string[] = [];
    return {
      writes,
      write: (chunk: string) => writes.push(chunk),
      end: (callback: () => void) => callback(),
      on: (_event: "error", listener: (error: Error) => void) => listeners.push(listener),
      fail: (error: Error) => listeners.forEach((listener) => listener(error)),
    };
  }

  const record = (): CensusRecord => priorRecord({ verdict: "verified" });

  it("writes one JSONL line per record while the stream is healthy", () => {
    const stream = fakeStream();
    const write = createReportWriter(stream, () => {});

    write(record());

    expect(stream.writes).toHaveLength(1);
    expect(JSON.parse(stream.writes[0])).toMatchObject({ facilityId: "facility-a", verdict: "verified" });
    expect(stream.writes[0].endsWith("\n")).toBe(true);
  });

  it("turns a stream error into a throw at the call site, so nothing writes on blind", () => {
    // Without the 'error' listener Node raises this asynchronously — past
    // main()'s .catch() — killing the run instead of aborting it.
    const logged: string[] = [];
    const stream = fakeStream();
    const write = createReportWriter(stream, (message) => logged.push(message));

    write(record());
    stream.fail(new Error("ENOSPC: no space left on device"));

    expect(() => write(record())).toThrow(/ENOSPC/);
    // The failed write is not silently counted as written.
    expect(stream.writes).toHaveLength(1);
    expect(logged.join("\n")).toMatch(/report stream failed/);
    // A second error does not re-log or change the reported cause.
    stream.fail(new Error("EACCES: permission denied"));
    expect(logged).toHaveLength(1);
    expect(() => write(record())).toThrow(/ENOSPC/);
  });
});

describe("endReportStream", () => {
  it("resolves as soon as the stream flushes", async () => {
    let ended = false;
    await endReportStream({ end: (callback) => { ended = true; callback(); } }, 50, () => {});
    expect(ended).toBe(true);
  });

  it("gives up on a stream whose end() never calls back, instead of parking the run", async () => {
    // An errored WriteStream can leave this callback unfired. This sits in a
    // `finally`, so hanging here strands an 8-12 hour run with no output.
    const logged: string[] = [];
    const start = Date.now();

    await endReportStream({ end: () => {} }, 20, (message) => logged.push(message));

    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    expect(logged.join("\n")).toMatch(/did not flush/);
  });
});

describe("selectCheckableFacilities", () => {
  it("keeps usable records and skips ones that cannot be named or keyed", () => {
    const { facilities, skipped } = selectCheckableFacilities([
      { id: "good", name: "Good DC", sources: [{ url: "https://a.example/" }] },
      { id: "nameless", sources: [{ url: "https://b.example/" }] },
      { name: "No Id DC" },
      { id: "blank", name: "" },
      null,
    ]);

    expect(facilities.map((facility) => facility.id)).toEqual(["good"]);
    expect(skipped).toHaveLength(4);
    // The id is named where we have one, so a human can find the record.
    expect(skipped[0]).toMatch(/^nameless — no name/);
    expect(skipped[1]).toMatch(/^record #2 — no id/);
    expect(skipped[2]).toMatch(/^blank — no name/);
    expect(skipped[3]).toMatch(/^record #4 — no id and name/);
  });

  it("never lets a nameless record reach the gate or produce a finding", async () => {
    // entityName: undefined makes the model reject, and that rejection would be
    // reported as a finding against a facility we never named.
    const { facilities, skipped } = selectCheckableFacilities([
      { id: "nameless", sources: [{ url: "https://nameless.example/" }] },
    ]);
    const { verify, calls } = fakeGate({}, "rejected");

    const summary = await runCensus(facilities, {
      verifyImpl: verify,
      passes: ["a"],
      concurrency: 1,
      onRecord: () => {},
    });

    expect(calls).toEqual([]);
    expect(summary.findings).toEqual([]);
    // Skipped, but not silently: the summary says so.
    expect(formatSummary(summary, 1000, skipped)).toContain("records skipped as uncheckable (missing id or name): 1");
    expect(formatSummary(summary, 1000, skipped)).toContain("nameless — no name");
    // A clean run still reports zero rather than omitting the line.
    expect(formatSummary(summary, 1000)).toContain("records skipped as uncheckable (missing id or name): 0");
  });
});

describe("isReplayable", () => {
  it("replays completed verdicts and re-checks transient ones", () => {
    expect(isReplayable(priorRecord({ verdict: "verified" }))).toBe(true);
    expect(isReplayable(priorRecord({ verdict: "rejected" }))).toBe(true);
    expect(isReplayable(priorRecord({ verdict: "escalate" }))).toBe(true);
    expect(isReplayable(priorRecord({ verdict: "unavailable" }))).toBe(false);
    expect(
      isReplayable(priorRecord({ verdict: "rejected", transportFailure: { reason: "network_error" } })),
    ).toBe(false);
  });
});

describe("runCensus — a thrown work unit", () => {
  const boom: VerifyImpl = async (url) => {
    throw new Error(`socket hang up on ${url}`);
  };

  it("keeps the run alive and records the failure as unavailable, never as evidence", async () => {
    const facilities = [
      makeFacility({ id: "f1", sources: [{ url: "https://boom.example/" }] }),
      makeFacility({ id: "f2", sources: [{ url: "https://fine.example/" }] }),
    ];
    const { verify } = fakeGate({});
    const records: CensusRecord[] = [];

    const summary = await runCensus(facilities, {
      // Throw on the first URL only; the rest of the run must still complete.
      verifyImpl: (url, claim) => (url === "https://boom.example/" ? boom(url, claim) : verify(url, claim)),
      passes: ["a"],
      concurrency: 1,
      onRecord: collect(records),
    });

    expect(summary.findings).toEqual([]);
    expect(summary.tallies).toMatchObject({ unavailable: 1, verified: 1 });
    expect(summary.escalations).toHaveLength(1);
    expect(summary.escalations[0].reason).toMatch(/census error/);
    // The failure is on disk, so --resume re-checks that key.
    expect(records.map((record) => record.verdict)).toEqual(["unavailable", "verified"]);
  });

  it("does not let throws trip the model-outage abort", async () => {
    // The abort exists to catch the verification model being down, which the
    // gate signals with a real `unavailable` verdict. Code-level throws are a
    // different failure class and must not kill a 55-minute run.
    const facilities = Array.from({ length: 5 }, (_, i) =>
      makeFacility({ id: `f${i}`, sources: [{ url: `https://boom${i}.example/` }] }),
    );

    const summary = await runCensus(facilities, {
      verifyImpl: boom,
      passes: ["a"],
      concurrency: 1,
      onRecord: () => {},
    });

    expect(summary.aborted).toBe(false);
    expect(summary.tallies.unavailable).toBe(5);
  });

  it("abandons a pass B unit that threw instead of claiming it is unsupported", async () => {
    const unit = makeFacility({
      id: "f1",
      capacityMw: { planned: 150 },
      sources: [{ url: "https://a.example/1" }, { url: "https://boom.example/" }],
    });
    const { verify } = fakeGate({}, "rejected");

    const summary = await runCensus([unit], {
      verifyImpl: (url, claim) => (url === "https://boom.example/" ? boom(url, claim) : verify(url, claim)),
      passes: ["b"],
      concurrency: 1,
      onRecord: () => {},
    });

    // The second source was never checked, so "no source supports this" is a
    // claim the run did not earn.
    expect(summary.findings).toEqual([]);
    expect(summary.unchecked).toHaveLength(1);
    expect(summary.unchecked[0].reason).toMatch(/census error/);
  });
});

describe("runCensus — deterministic output ordering", () => {
  it("sorts findings so two runs of the same data diff cleanly", async () => {
    const facilities = ["f3", "f1", "f2"].map((id) =>
      makeFacility({ id, sources: [{ url: `https://${id}.example/` }] }),
    );
    const { verify } = fakeGate({}, "rejected");

    const summary = await runCensus(facilities, {
      verifyImpl: verify,
      passes: ["a"],
      concurrency: 3,
      onRecord: () => {},
    });

    expect(summary.findings.map((finding) => finding.facilityId)).toEqual(["f1", "f2", "f3"]);
  });
});

describe("readReport", () => {
  function writeReport(lines: string[]): string {
    const dir = mkdtempSync(path.join(tmpdir(), "census-report-"));
    const file = path.join(dir, "source-census-test.jsonl");
    writeFileSync(file, lines.join("\n"), "utf8");
    return file;
  }

  it("returns nothing for a report that does not exist", () => {
    expect(readReport(path.join(tmpdir(), "census-nope", "missing.jsonl"))).toEqual([]);
  });

  it("reads valid lines and drops a truncated trailing one", () => {
    const good = priorRecord({ facilityId: "f1", verdict: "verified" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const records = readReport(writeReport([JSON.stringify(good), '{"pass":"a","facilityId":"f2"']));
    warn.mockRestore();

    expect(records).toEqual([good]);
  });

  it("skips a null line and an out-of-enum verdict rather than corrupting the tallies", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reportPath = writeReport([
      "null",
      JSON.stringify({ ...priorRecord({ verdict: "verified" }), verdict: "definitely-not-a-verdict" }),
      JSON.stringify(priorRecord({ facilityId: "f1", url: "https://one.example/", verdict: "verified" })),
    ]);
    const records = readReport(reportPath);
    const warnings = warn.mock.calls.length; // mockRestore() clears the history
    warn.mockRestore();

    expect(records).toHaveLength(1);
    expect(warnings).toBe(1);

    // A surviving bad verdict would make tallies[verdict] silently NaN.
    const summary = await runCensus([makeFacility({ id: "f1", sources: [{ url: "https://one.example/" }] })], {
      verifyImpl: fakeGate({}).verify,
      passes: ["a"],
      concurrency: 1,
      onRecord: () => {},
      priorRecords: records,
    });
    expect(Object.values(summary.tallies).every(Number.isFinite)).toBe(true);
  });
});

describe("sourceUrls", () => {
  it("keeps citation order, de-duplicates, and ignores non-string urls", () => {
    expect(
      sourceUrls({
        id: "f1",
        name: "F1",
        sources: [
          { url: "https://b.example/" },
          { url: "https://a.example/" },
          { url: "https://b.example/" },
          { url: "" },
          { url: 42 },
          {},
        ],
      }),
    ).toEqual(["https://b.example/", "https://a.example/"]);
  });

  it("handles a facility with no sources at all", () => {
    expect(sourceUrls({ id: "f1", name: "F1" })).toEqual([]);
  });
});

describe("makeRunId", () => {
  it("is a filename-safe, sortable timestamp with no colons or milliseconds", () => {
    const runId = makeRunId(new Date("2026-08-13T11:30:05.123Z"));
    expect(runId).toBe("2026-08-13T11-30-05");
    expect(runId).not.toContain(":");
    // Lexicographic order is chronological order — what --resume relies on.
    expect(makeRunId(new Date("2026-08-13T09:00:00Z")) < runId).toBe(true);
  });
});

describe("recordKey", () => {
  it("distinguishes every field it is keyed on", () => {
    const key = recordKey("a", "f1", "https://one.example/", "planned");
    expect(key).toBe(recordKey("a", "f1", "https://one.example/", "planned"));
    expect(key).not.toBe(recordKey("b", "f1", "https://one.example/", "planned"));
    expect(key).not.toBe(recordKey("a", "f2", "https://one.example/", "planned"));
    expect(key).not.toBe(recordKey("a", "f1", "https://two.example/", "planned"));
    expect(key).not.toBe(recordKey("a", "f1", "https://one.example/", "operational"));
  });

  it("cannot be spoofed by a field boundary — the separator is not url-legal", () => {
    expect(recordKey("a", "f1|https://x", "", "")).not.toBe(recordKey("a", "f1", "https://x", ""));
  });
});
