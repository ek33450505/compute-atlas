import { describe, expect, it } from "vitest";

import type { FetchPageTextResult } from "./fetch-page-text";
import {
  formatSummary,
  isTriageCandidate,
  matchMachineDataRule,
  parseCensusLine,
  runTriage,
  sourceKindKey,
  strongEntityTokens,
  tallyBuckets,
  weakEntityTokens,
  type CensusRecord,
} from "./census-triage";

function censusRecord(overrides: Partial<CensusRecord> = {}): CensusRecord {
  return {
    pass: "a",
    facilityId: "aligned-dfw-03-tx",
    facilityName: "Aligned DFW-03",
    url: "https://example.com/story",
    verdict: "rejected",
    ...overrides,
  };
}

/** A fake page source — never a real fetch, and it records what it was asked for. */
function pageSource(pages: Record<string, string | Extract<FetchPageTextResult, { ok: false }>>) {
  const requested: string[] = [];
  const impl = async (url: string): Promise<FetchPageTextResult> => {
    requested.push(url);
    const page = pages[url];
    if (page === undefined) return { ok: false, reason: "http_error", httpStatus: 404 };
    if (typeof page === "string") return { ok: true, text: page, finalUrl: url, httpStatus: 200 };
    return page;
  };
  return { impl, requested };
}

describe("token rule", () => {
  it("keeps distinctive tokens and drops short/generic ones", () => {
    expect(strongEntityTokens("Aligned DFW-03 Data Center")).toEqual(["aligned"]);
    expect(strongEntityTokens("Vernon LA Campus (with Goodman Group)")).toEqual(["vernon", "goodman"]);
    expect(weakEntityTokens("Vernon LA Campus (with Goodman Group)")).toEqual(["la", "with"]);
  });

  it("drops the observed suppression tokens: with, us, proposed", () => {
    expect(strongEntityTokens("Microsoft Boydton Campus (BN / Azure East US)")).not.toContain("us");
    expect(strongEntityTokens("Google Nebraska AI Campus (proposed)")).not.toContain("proposed");
    expect(strongEntityTokens("Google Nebraska AI Campus (proposed)")).not.toContain("ai");
  });
});

describe("machine-data rules", () => {
  it("matches GIS and OSM hosts, including subdomains and self-hosted servers", () => {
    expect(matchMachineDataRule("https://www.arcgis.com/home/item.html?id=abc")?.name).toBe("arcgis-host");
    expect(matchMachineDataRule("https://services5.arcgis.com/x/ArcGIS/rest")?.name).toBe("arcgis-host");
    expect(matchMachineDataRule("https://arcgisserver.digital.mass.gov/x")?.name).toBe("arcgis-host");
    expect(matchMachineDataRule("https://www.openstreetmap.org/way/483286527")?.name).toBe(
      "openstreetmap-host",
    );
    expect(matchMachineDataRule("https://openstreetmap.org/node/1")?.name).toBe("openstreetmap-host");
  });

  it("matches data endpoints by path and format query", () => {
    expect(matchMachineDataRule("https://gis.example.gov/rest/services/x/FeatureServer/0")?.name).toBe(
      "gis-service-path",
    );
    expect(matchMachineDataRule("https://gis.example.gov/rest/services/x/MapServer")?.name).toBe(
      "gis-service-path",
    );
    expect(matchMachineDataRule("https://gis.example.gov/query?f=geojson")?.name).toBe("data-format-query");
    expect(matchMachineDataRule("https://gis.example.gov/query?f=json")?.name).toBe("data-format-query");
  });

  it("leaves prose URLs and unparseable URLs alone", () => {
    expect(matchMachineDataRule("https://www.dallasnews.com/story-about-a-campus")).toBeUndefined();
    // A host merely mentioning "openstreetmap" in the path is not an OSM host.
    expect(matchMachineDataRule("https://blog.example.com/openstreetmap-explained")).toBeUndefined();
    expect(matchMachineDataRule("not a url")).toBeUndefined();
  });
});

describe("candidate selection", () => {
  it("accepts only pass-A rejections whose page was read", () => {
    expect(isTriageCandidate(censusRecord())).toBe(true);
    expect(isTriageCandidate(censusRecord({ pass: "b" }))).toBe(false);
    expect(isTriageCandidate(censusRecord({ verdict: "verified" }))).toBe(false);
    expect(
      isTriageCandidate(censusRecord({ transportFailure: { reason: "http_error", httpStatus: 403 } })),
    ).toBe(false);
  });

  it("parses a census line and rejects malformed input", () => {
    const line = JSON.stringify(censusRecord({ transportFailure: { reason: "http_error" } }));
    expect(parseCensusLine(line)?.facilityId).toBe("aligned-dfw-03-tx");
    expect(parseCensusLine("not json")).toBeUndefined();
    expect(parseCensusLine("")).toBeUndefined();
    expect(parseCensusLine(JSON.stringify({ pass: "a", verdict: "rejected" }))).toBeUndefined();
  });
});

describe("runTriage", () => {
  it("buckets a page that contains a strong token as named, not absent", async () => {
    const { impl } = pageSource({
      "https://example.com/story": "Aligned Data Centers broke ground on its Dallas campus this week.",
    });
    const [record] = await runTriage([censusRecord()], { fetchPageTextImpl: impl });

    expect(record.bucket).toBe("named");
    expect(record.bucket).not.toBe("absent");
    expect(record.matchedStrong).toEqual(["aligned"]);
  });

  it("does NOT call a page named when only weak tokens match", async () => {
    // The suppression guard: "with"/"us"/"proposed" match almost any page, so
    // matching one must never hide a real finding.
    const { impl } = pageSource({
      "https://example.com/story": "The board met with staff about a proposed rezoning for us.",
    });
    const [record] = await runTriage(
      [censusRecord({ facilityName: "Vernon LA Campus (with Goodman Group)" })],
      { fetchPageTextImpl: impl },
    );

    expect(record.bucket).not.toBe("named");
    expect(record.bucket).toBe("weak-only");
    expect(record.matchedStrong).toEqual([]);
    expect(record.matchedWeak).toContain("with");
  });

  it("buckets a page naming nothing as absent and reports the tokens searched", async () => {
    const { impl } = pageSource({
      "https://example.com/story": "Oncor Electric Delivery is a regulated transmission utility.",
    });
    const [record] = await runTriage([censusRecord()], { fetchPageTextImpl: impl });

    expect(record.bucket).toBe("absent");
    expect(record.strongTokens).toEqual(["aligned"]);
    expect(record.matchedStrong).toEqual([]);
    expect(formatSummary([record])).toContain("searched for (none found): aligned");
    expect(formatSummary([record])).toContain("ABSENT COUNT: 1");
  });

  it("never triages — or even fetches — a record carrying a transportFailure", async () => {
    const { impl, requested } = pageSource({ "https://example.com/story": "Aligned" });
    const records = await runTriage(
      [censusRecord({ transportFailure: { reason: "http_error", httpStatus: 403 } })],
      { fetchPageTextImpl: impl },
    );

    expect(records).toEqual([]);
    expect(requested).toEqual([]);
  });

  it("buckets a name with no strong tokens as no-strong-tokens, never absent", async () => {
    const { impl, requested } = pageSource({ "https://example.com/story": "Nothing relevant here." });
    const [record] = await runTriage([censusRecord({ facilityName: "New Power Campus (proposed)" })], {
      fetchPageTextImpl: impl,
    });

    expect(record.bucket).toBe("no-strong-tokens");
    expect(record.bucket).not.toBe("absent");
    expect(record.strongTokens).toEqual([]);
    // Untestable names cost no fetch.
    expect(requested).toEqual([]);
  });

  it("buckets an osm-kind source as machine-data, never absent", async () => {
    // The URL alone gives no signal here — only the curated source kind does.
    const url = "https://data.example.gov/records/483286527";
    const { impl, requested } = pageSource({ [url]: "Nothing relevant here." });
    const record = censusRecord({ url });
    const [triaged] = await runTriage([record], {
      fetchPageTextImpl: impl,
      sourceKinds: new Map([[sourceKindKey(record.facilityId, url), "osm"]]),
    });

    expect(triaged.bucket).toBe("machine-data");
    expect(triaged.bucket).not.toBe("absent");
    expect(triaged.machineDataReason).toBe("source kind osm");
    // Machine data costs no fetch.
    expect(requested).toEqual([]);
  });

  it("buckets an arcgis.com URL as machine-data even with no source-kind join", async () => {
    const url = "https://www.arcgis.com/home/item.html?id=abc123";
    const { impl } = pageSource({ [url]: "ArcGIS item details." });
    const [record] = await runTriage(
      [censusRecord({ facilityId: "60-hudson-street-ny", facilityName: "60 Hudson Street", url })],
      { fetchPageTextImpl: impl },
    );

    expect(record.bucket).toBe("machine-data");
    expect(record.machineDataReason).toContain("arcgis-host");
  });

  it("buckets an arcgis subdomain as machine-data", async () => {
    const url = "https://services5.arcgis.com/abc/ArcGIS/rest/services/Sites/FeatureServer/0";
    const { impl } = pageSource({ [url]: "{}" });
    const [record] = await runTriage([censusRecord({ url })], { fetchPageTextImpl: impl });

    expect(record.bucket).toBe("machine-data");
  });

  it("leaves a normal press URL on the token test path", async () => {
    const url = "https://www.dallasnews.com/2026/aligned-dfw";
    const { impl, requested } = pageSource({ [url]: "Aligned broke ground in Dallas." });
    const record = censusRecord({ url });
    const [triaged] = await runTriage([record], {
      fetchPageTextImpl: impl,
      sourceKinds: new Map([[sourceKindKey(record.facilityId, url), "press"]]),
    });

    expect(triaged.bucket).toBe("named");
    expect(triaged.machineDataReason).toBeUndefined();
    expect(requested).toEqual([url]);
  });

  it("counts machine-data separately and keeps it out of the absent list", async () => {
    const gisUrl = "https://www.arcgis.com/home/item.html?id=abc123";
    const { impl } = pageSource({
      [gisUrl]: "ArcGIS item details.",
      "https://example.com/story": "Oncor Electric Delivery is a regulated utility.",
    });
    const records = await runTriage([censusRecord(), censusRecord({ url: gisUrl })], {
      fetchPageTextImpl: impl,
    });

    expect(tallyBuckets(records)).toMatchObject({ absent: 1, "machine-data": 1 });
    const summary = formatSummary(records);
    expect(summary).toContain("ABSENT COUNT: 1");
    expect(summary).not.toContain(gisUrl);
    expect(summary).toContain("machine-data      1");
  });

  it("buckets a failed re-fetch as unreadable, never absent", async () => {
    const { impl } = pageSource({
      "https://example.com/story": { ok: false, reason: "http_error", httpStatus: 429 },
    });
    const [record] = await runTriage([censusRecord()], { fetchPageTextImpl: impl });

    expect(record.bucket).toBe("unreadable");
    expect(record.bucket).not.toBe("absent");
    expect(record.fetchFailure).toBe("http_error (HTTP 429)");
  });

  it("buckets a thrown fetch as unreadable rather than failing the batch", async () => {
    const impl = async (): Promise<FetchPageTextResult> => {
      throw new Error("socket hang up");
    };
    const [record] = await runTriage([censusRecord()], { fetchPageTextImpl: impl });

    expect(record.bucket).toBe("unreadable");
    expect(record.fetchFailure).toBe("network_error");
  });

  it("prefers the live facility name and notes the mismatch", async () => {
    const { impl } = pageSource({ "https://example.com/story": "Nothing relevant here." });
    const [record] = await runTriage([censusRecord()], {
      fetchPageTextImpl: impl,
      liveNames: new Map([["aligned-dfw-03-tx", "Vantage Dallas DFW-03"]]),
    });

    expect(record.facilityName).toBe("Vantage Dallas DFW-03");
    expect(record.censusName).toBe("Aligned DFW-03");
    expect(record.nameSource).toBe("live");
    expect(record.strongTokens).toContain("vantage");
  });

  it("fetches each URL once even when several facilities cite it", async () => {
    const { impl, requested } = pageSource({ "https://example.com/story": "Aligned and Vantage." });
    const records = await runTriage(
      [censusRecord(), censusRecord({ facilityId: "vantage-dfw-01-tx", facilityName: "Vantage DFW-01" })],
      { fetchPageTextImpl: impl },
    );

    expect(requested).toEqual(["https://example.com/story"]);
    expect(records.map((record) => record.bucket)).toEqual(["named", "named"]);
  });

  it("matches whole words only, so a substring cannot suppress a finding", async () => {
    const { impl } = pageSource({ "https://example.com/story": "The plan was misaligned with the county." });
    const [record] = await runTriage([censusRecord()], { fetchPageTextImpl: impl });

    expect(record.bucket).toBe("absent");
  });

  it("honours --limit and reports every bucket in the tally", async () => {
    const { impl } = pageSource({ "https://example.com/story": "Aligned Data Centers." });
    const records = await runTriage([censusRecord(), censusRecord({ facilityId: "second" })], {
      fetchPageTextImpl: impl,
      limit: 1,
    });

    expect(records).toHaveLength(1);
    expect(tallyBuckets(records)).toEqual({
      absent: 0,
      "weak-only": 0,
      named: 1,
      unreadable: 0,
      "no-strong-tokens": 0,
      "machine-data": 0,
    });
  });
});
