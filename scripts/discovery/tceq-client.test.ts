// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  assertSummaryUrl,
  buildSearchBody,
  decodeEntities,
  createTceqSession,
  dedupeByPermit,
  fetchTxr15Summary,
  isoToUsDate,
  parseResultsPage,
  parseSummaryPage,
  searchTxr15,
  usDateToIso,
} from "./tceq-client";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => readFileSync(path.join(here, "tceq-fixtures", n), "utf8");
const RESULTS = fixture("results-page.html");
const SUMMARY = fixture("summary-TXR1551YV.html");
const FORM = "https://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.permit_info_search";
const SUMMARY_URL =
  "https://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.permit_summary&lgl_ident_txt=TXR1551YV&lgl_id=33025390";

interface Call {
  url: string;
  method: string;
  body?: string;
  cookie?: string;
}

function fakeFetch(respond: (c: Call) => string, cookies: string[] = []) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = { url, method: init.method ?? "GET", body: init.body as string | undefined, cookie: headers.cookie };
    calls.push(call);
    const h = new Headers();
    for (const c of cookies) h.append("set-cookie", c);
    return new Response(respond(call), { status: 200, headers: h });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const noGate = async () => {};

const HEADER =
  "<tr>" +
  ["Auth #", "Site Name", "Permittee", "SIC Code", "Segment #", "County", "Region", "City", "Site Location"]
    .map((h) => `<th><a href="x">${h}</a></th>`)
    .join("") +
  "</tr>";

function pageHtml(reported: number | null, nRows: number, start = 0): string {
  const rows = Array.from({ length: nRows }, (_, i) => {
    const n = `TXR15${String(start + i).padStart(5, "0")}`;
    return `<tr><td><a href="index.cfm?fuseaction=home.permit_summary&amp;lgl_ident_txt=${n}">${n}</a></td><td>S${n}</td><td>P</td><td>1</td><td>2</td><td>X</td><td>11</td><td>Y</td><td>loc</td></tr>`;
  }).join("");
  const head = reported === null ? "<p>form</p>" : `Your search returned ${reported} records.`;
  return `${head}<table>${HEADER}${rows}</table>`;
}

describe("dates", () => {
  it("converts both ways and rejects impossible dates", () => {
    expect(usDateToIso("07/14/2026")).toBe("2026-07-14");
    expect(isoToUsDate("2026-07-14")).toBe("07/14/2026");
    expect(usDateToIso("13/40/2026")).toBeUndefined();
    expect(usDateToIso("")).toBeUndefined();
    expect(isoToUsDate("nope")).toBeUndefined();
  });
});

describe("parseResultsPage", () => {
  const { reported, rows } = parseResultsPage(RESULTS);

  it("reads the count and every raw row", () => {
    expect(reported).toBe(6);
    expect(rows).toHaveLength(6);
  });

  it("parses the real TXR1551YV row and drops the site-location column", () => {
    expect(rows[0]).toEqual({
      permitNumber: "TXR1551YV",
      summaryUrl:
        "https://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.permit_summary&lgl_ident_txt=TXR1551YV&lgl_id=33025390&pita_id=33025393&phys_id=33025392&princ_id=109520552026195&affil_role=2&reg_ent_id=713338142003015&permit_type_code=SWC&return_to=permit_list",
      siteName: "BCG CEDAR CREEK CAMPUS",
      permittee: "Black Chamber Partners, LLC",
      sic: "1541",
      segment: "1244",
      county: "BASTROP",
      city: "CEDAR CREEK",
    });
    expect(JSON.stringify(rows)).not.toContain("EXAMPLE ST");
  });

  it("dedupes by permit number, keeping the first", () => {
    const d = dedupeByPermit(rows);
    expect(d.map((r) => r.permitNumber)).toEqual(["TXR1551YV", "TXR1599ZZ", "TXR1599ZY", "TXR1599ZX"]);
    expect(d.find((r) => /DATA CENTER/.test(r.siteName))?.permitNumber).toBe("TXR1599ZY");
  });

  it("omits blank optional columns", () => {
    const c = rows.find((r) => r.permitNumber === "TXR1599ZX");
    expect(c?.sic).toBeUndefined();
    expect(c?.segment).toBeUndefined();
  });

  it("fails closed on shifted, extra or missing columns", () => {
    const row = (cells: number) =>
      `<tr><td><a href="index.cfm?fuseaction=home.permit_summary&amp;lgl_ident_txt=A">A</a></td>${"<td>x</td>".repeat(cells - 1)}</tr>`;
    expect(() => parseResultsPage(`<table>${HEADER}${row(8)}</table>`)).toThrow(/8 cells/);
    expect(() => parseResultsPage(`<table>${HEADER}${row(10)}</table>`)).toThrow(/10 cells/);
    const swapped = HEADER.replace("Permittee", "@@").replace("County", "Permittee").replace("@@", "County");
    expect(() => parseResultsPage(`<table>${swapped}${row(9)}</table>`)).toThrow(/columns changed/);
    expect(() => parseResultsPage(`<table>${HEADER.replace("<th><a href=\"x\">City</a></th>", "")}${row(9)}</table>`)).toThrow(/columns changed/);
    expect(() => parseResultsPage(`<table>${row(9)}</table>`)).toThrow(/before a header/);
  });

  it("rejects a row whose link is not a TCEQ summary URL", () => {
    const bad = `<tr><td><a href="https://evil.example/wq_dpa/index.cfm?fuseaction=home.permit_summary">A</a></td>${"<td>x</td>".repeat(8)}</tr>`;
    expect(() => parseResultsPage(`<table>${HEADER}${bad}</table>`)).toThrow(/refusing/);
  });

  it("does not read a bare comma as a count of zero", () => {
    expect(parseResultsPage("Your search returned , records.").reported).toBeUndefined();
  });

  it("returns no count for a page without one", () => {
    expect(parseResultsPage("<form>search again</form>").reported).toBeUndefined();
  });

  it("reads TCEQ's real empty-search page as zero records", () => {
    expect(parseResultsPage(fixture("no-results.html"))).toEqual({ reported: 0, rows: [] });
    expect(parseResultsPage("*** there  WERE no permits\nfound that match the search criteria provided. ***").reported).toBe(0);
  });

  it("does not read different wording or a re-served form as zero", () => {
    expect(parseResultsPage("<p>There were no permits found.</p>").reported).toBeUndefined();
    expect(parseResultsPage("<form><input name='permit_status'/> Search criteria</form>").reported).toBeUndefined();
  });
});

describe("parseSummaryPage", () => {
  const s = parseSummaryPage(SUMMARY, SUMMARY_URL);

  it("extracts the measured fields", () => {
    expect(s).toEqual({
      permitNumber: "TXR1551YV",
      status: "ACTIVE",
      coverageBegan: "2026-07-14",
      siteName: "BCG CEDAR CREEK CAMPUS",
      sic: "1541",
      areaDisturbedAcres: 304,
      estimatedStart: "2026-09-01",
      estimatedEnd: "2028-10-01",
      receivingWater: "BRUSHY CREEK",
      segment: "1244",
      operatorName: "Black Chamber Partners, LLC",
      county: "BASTROP",
      lat: 30.057081,
      lon: -97.428818,
    });
  });

  it("never carries contact or address data", () => {
    const json = JSON.stringify(s);
    expect(json).not.toContain("@");
    expect(json).not.toMatch(/\d{3}[-. )]+\d{3}[-. ]\d{4}/);
    expect(json).not.toContain("EXAMPLE ST");
    expect(json).not.toContain("SAMPLE RANCH");
    expect(Object.keys(s)).not.toContain("address");
  });

  it("treats 0/0 coordinates as absent", () => {
    const html = SUMMARY.replace("Latitude:</label>30.057081", "Latitude:</label>0").replace(
      "Longitude:</label>-97.428818",
      "Longitude:</label>0",
    );
    const z = parseSummaryPage(html, SUMMARY_URL);
    expect(z.lat).toBeUndefined();
    expect(z.lon).toBeUndefined();
  });

  it("drops out-of-range or half-present coordinates", () => {
    const withCoords = (lat: string, lon: string) =>
      parseSummaryPage(
        SUMMARY.replace("Latitude:</label>30.057081", `Latitude:</label>${lat}`).replace("Longitude:</label>-97.428818", `Longitude:</label>${lon}`),
        SUMMARY_URL,
      );
    for (const [lat, lon] of [["95", "-97"], ["30", "-181"], ["0", "-97"], ["30", "0"], ["abc", "-97"]]) {
      const r = withCoords(lat, lon);
      expect(r.lat).toBeUndefined();
      expect(r.lon).toBeUndefined();
    }
    expect(withCoords("30.5", "-97.5")).toMatchObject({ lat: 30.5, lon: -97.5 });
  });

  it("throws without a Permit Number", () => {
    expect(() => parseSummaryPage("<html>nothing</html>", SUMMARY_URL)).toThrow(/Permit Number/);
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities and leaves unknown ones", () => {
    expect(decodeEntities("A &amp; B&nbsp;C &#39;x&#x27; &bogus; &#0;")).toBe("A & B C 'x' &bogus; &#0;");
  });
});

describe("assertSummaryUrl", () => {
  const ok = "https://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.permit_summary";
  it("accepts the canonical URL and an uppercase host (WHATWG lowercases it)", () => {
    expect(assertSummaryUrl(ok).href).toBe(ok);
    expect(assertSummaryUrl(ok.replace("www2.tceq", "WWW2.TCEQ")).origin).toBe("https://www2.tceq.texas.gov");
  });
  it.each([
    ["userinfo", "https://user:pw@www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.permit_summary"],
    ["username only", "https://user@www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.permit_summary"],
    ["port", "https://www2.tceq.texas.gov:8443/wq_dpa/index.cfm?fuseaction=home.permit_summary"],
    ["duplicate fuseaction", `${ok}&fuseaction=home.permit_list`],
  ])("rejects %s", (_n, url) => expect(() => assertSummaryUrl(url)).toThrow(/refusing/));
});

describe("buildSearchBody", () => {
  it("throws unless exactly one of permitStatus and appStatus is set", () => {
    expect(() => buildSearchBody({ permitStatus: "ACTIVE", appStatus: "PENDING" })).toThrow(/exactly one/);
    expect(() => buildSearchBody({ county: "BASTROP" })).toThrow(/exactly one/);
    expect(buildSearchBody({ appStatus: "PENDING" })).toContain("app_status=PENDING");
  });

  it("carries the image-submit pair with an encoded '=' in the name", () => {
    const b = buildSearchBody({ permitStatus: "ACTIVE", county: "BASTROP", startDate: "2026-06-01", endDate: "2026-11-13" });
    expect(b).toContain("_fuseaction%3Dhome.validate_search_crit.x=5&_fuseaction%3Dhome.validate_search_crit.y=5");
    expect(b).toContain("permit_type=SWC%7CConstruction+Notice+of+Intent+(TXR15)");
    expect(b).toContain("permit_status=ACTIVE");
    expect(b).not.toContain("app_status");
    expect(b).toContain("cnty_name=BASTROP");
    expect(b).toContain("start_date=06%2F01%2F2026");
    expect(b).toContain("end_date=11%2F13%2F2026");
  });
});

describe("createTceqSession + searchTxr15", () => {
  const cookies = ["CFID=111; path=/", "CFTOKEN=222; path=/; HttpOnly", "__cf_bm=abc; path=/"];

  it("captures cookies, replays them, posts the form and walks pages 2..n", async () => {
    const { f, calls } = fakeFetch((c) => {
      if (c.method === "POST") return pageHtml(120, 50);
      if (c.url.includes("CurrentPage=2")) return pageHtml(120, 50, 50);
      if (c.url.includes("CurrentPage=3")) return pageHtml(120, 20, 100);
      return "<form/>";
    }, cookies);
    const session = createTceqSession({ fetch: f, rateGate: noGate });
    const res = await searchTxr15(session, { permitStatus: "ACTIVE", county: "BASTROP" });
    expect(res.reported).toBe(120);
    expect(res.rows).toHaveLength(120);
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "GET", "GET"]);
    expect(calls[0].cookie).toBeUndefined();
    expect(calls[1].cookie).toBe("CFID=111; CFTOKEN=222; __cf_bm=abc");
    expect(calls[1].body).toContain("_fuseaction%3Dhome.validate_search_crit.x=5");
    expect(calls[2].url).toContain("CurrentPage=2&fuseaction=home.permit_list&sort=lgl_ident_txt");
    expect(calls[3].url).toContain("CurrentPage=3");
    expect(calls[3].cookie).toContain("CFID=111");
  });

  it("fails closed when the walked row total differs from the reported count", async () => {
    const { f } = fakeFetch((c) => (c.method === "POST" ? pageHtml(60, 50) : c.url.includes("CurrentPage=2") ? pageHtml(60, 9, 50) : ""));
    await expect(searchTxr15(createTceqSession({ fetch: f, rateGate: noGate }), { permitStatus: "ACTIVE" })).rejects.toThrow(/59 rows.*reported 60/);
  });

  it("throws when the results page has no record count", async () => {
    const { f } = fakeFetch((c) => (c.method === "POST" ? pageHtml(null, 0) : ""));
    await expect(searchTxr15(createTceqSession({ fetch: f, rateGate: noGate }), { permitStatus: "ACTIVE" })).rejects.toThrow(/no record count/);
  });

  it("refuses to truncate past maxPages", async () => {
    const { f, calls } = fakeFetch((c) => (c.method === "POST" ? pageHtml(2075, 50) : ""));
    await expect(searchTxr15(createTceqSession({ fetch: f, rateGate: noGate }), { permitStatus: "ACTIVE" }, { maxPages: 10 })).rejects.toThrow(/narrow the search/);
    expect(calls.filter((c) => c.url.includes("CurrentPage"))).toHaveLength(0);
  });

  it("returns an empty result for TCEQ's real no-results page", async () => {
    const { f } = fakeFetch((c) => (c.method === "POST" ? fixture("no-results.html") : ""));
    expect(await searchTxr15(createTceqSession({ fetch: f, rateGate: noGate }), { permitStatus: "ACTIVE" })).toEqual({ reported: 0, rows: [] });
  });

  it("returns an empty result for zero records", async () => {
    const { f } = fakeFetch((c) => (c.method === "POST" ? "Your search returned 0 records." : ""));
    expect(await searchTxr15(createTceqSession({ fetch: f, rateGate: noGate }), { permitStatus: "ACTIVE" })).toEqual({ reported: 0, rows: [] });
  });

  it("throws on a non-2xx response", async () => {
    const f = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    await expect(searchTxr15(createTceqSession({ fetch: f, rateGate: noGate }), { permitStatus: "ACTIVE" })).rejects.toThrow(/HTTP 503/);
  });

  it("refuses off-origin URLs before calling fetch", async () => {
    const { f, calls } = fakeFetch(() => "x", ["A=1"]);
    const session = createTceqSession({ fetch: f, rateGate: noGate });
    await expect(session.get("https://evil.example/x")).rejects.toThrow(/off-origin/);
    await expect(session.post("http://www2.tceq.texas.gov/wq_dpa/index.cfm", "a=b")).rejects.toThrow(/off-origin/);
    expect(calls).toHaveLength(0);
  });

  it("treats a 3xx as an error, sends redirect: manual, and drops its cookies", async () => {
    const inits: RequestInit[] = [];
    let n = 0;
    const f = (async (_u: string, init: RequestInit) => {
      inits.push(init);
      const h = new Headers({ location: "https://evil.example/", "set-cookie": "EVIL=1; path=/" });
      return n++ === 0 ? new Response(null, { status: 302, headers: h }) : new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const session = createTceqSession({ fetch: f, rateGate: noGate });
    await expect(session.get(FORM)).rejects.toThrow(/redirected \(HTTP 302\)/);
    await session.get(FORM);
    expect(inits[0].redirect).toBe("manual");
    expect((inits[1].headers as Record<string, string>).cookie).toBeUndefined();
  });

  it("rejects a response whose url is off-origin, without keeping its cookies", async () => {
    const seen: Array<string | undefined> = [];
    let n = 0;
    const f = (async (_u: string, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>).cookie);
      const res = new Response("ok", { status: 200, headers: n === 0 ? { "set-cookie": "EVIL=1" } : {} });
      if (n++ === 0) Object.defineProperty(res, "url", { value: "https://evil.example/" });
      return res;
    }) as unknown as typeof fetch;
    const session = createTceqSession({ fetch: f, rateGate: noGate });
    await expect(session.get(FORM)).rejects.toThrow(/off-origin/);
    await session.get(FORM);
    expect(seen[1]).toBeUndefined();
  });

  it("overwrites a cookie on refresh", async () => {
    let n = 0;
    const calls: Call[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: "GET", cookie: (init.headers as Record<string, string>).cookie });
      return new Response("ok", { headers: { "set-cookie": `CFID=${++n}; path=/` } });
    }) as unknown as typeof fetch;
    const session = createTceqSession({ fetch: f, rateGate: noGate });
    await session.get(FORM);
    await session.get(FORM);
    await session.get(FORM);
    expect(calls.map((c) => c.cookie)).toEqual([undefined, "CFID=1", "CFID=2"]);
  });

  it("passes an AbortSignal to fetch", async () => {
    let signal: unknown;
    const f = (async (_u: string, init: RequestInit) => ((signal = init.signal), new Response("ok"))) as unknown as typeof fetch;
    await createTceqSession({ fetch: f, rateGate: noGate, timeoutMs: 5000 }).get(FORM);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("caps the response body at 5 MB", async () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    const streamed = (async () => new Response(big, { status: 200 })) as unknown as typeof fetch;
    await expect(createTceqSession({ fetch: streamed, rateGate: noGate }).get(FORM)).rejects.toThrow(/exceeded/);
    const declared = (async () =>
      new Response("x", { status: 200, headers: { "content-length": String(6 * 1024 * 1024) } })) as unknown as typeof fetch;
    await expect(createTceqSession({ fetch: declared, rateGate: noGate }).get(FORM)).rejects.toThrow(/too large/);
  });

  it("calls the rate gate before every request", async () => {
    let gated = 0;
    const { f } = fakeFetch((c) => (c.method === "POST" ? pageHtml(1, 1) : ""));
    await searchTxr15(createTceqSession({ fetch: f, rateGate: async () => void gated++ }), { permitStatus: "ACTIVE" });
    expect(gated).toBe(2);
  });
});

describe("fetchTxr15Summary", () => {
  it("fetches an allowed summary URL without cookies and parses it", async () => {
    const { f, calls } = fakeFetch(() => SUMMARY, ["CFID=1; path=/"]);
    const session = createTceqSession({ fetch: f, rateGate: noGate });
    await session.get("https://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.permit_info_search");
    const s = await fetchTxr15Summary(session, SUMMARY_URL);
    expect(s.permitNumber).toBe("TXR1551YV");
    expect(calls[1].cookie).toBeUndefined();
  });

  it.each([
    "https://evil.example/wq_dpa/index.cfm?fuseaction=home.permit_summary",
    "http://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.permit_summary",
    "https://www2.tceq.texas.gov/other/index.cfm?fuseaction=home.permit_summary",
    "https://www2.tceq.texas.gov/wq_dpa/index.cfm?fuseaction=home.permit_list",
    "https://www2.tceq.texas.gov@evil.example/wq_dpa/index.cfm?fuseaction=home.permit_summary",
  ])("rejects %s", async (url) => {
    const { f, calls } = fakeFetch(() => SUMMARY);
    await expect(fetchTxr15Summary(createTceqSession({ fetch: f, rateGate: noGate }), url)).rejects.toThrow(/refusing/);
    expect(calls).toHaveLength(0);
  });
});
