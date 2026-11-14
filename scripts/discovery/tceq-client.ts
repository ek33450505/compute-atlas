// Read-only client for the Texas TCEQ stormwater permit search (TXR15 construction
// notices of intent). Public state server: one request per second, our own UA.
// Parsing is regex/string based on purpose: the pages are simple table markup and
// jsdom is a devDependency. Never parsed: Address, Annual Fee Billing Address, Site
// Location, the regulated-entity block's names and coordinates, emails, phones. The
// name fields (site name, permittee, operator) CAN hold an individual's name.

import { USER_AGENT } from "./fetch-url";
import { createRateGate } from "./net-guard";

const ORIGIN = "https://www2.tceq.texas.gov";
const INDEX_PATH = "/wq_dpa/index.cfm";
const INDEX_URL = `${ORIGIN}${INDEX_PATH}`;
const FORM_URL = `${INDEX_URL}?fuseaction=home.permit_info_search`;
const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 60;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface TceqRow {
  permitNumber: string;
  summaryUrl: string;
  /**
   * May hold an individual's name. Do not store or display except under an explicit
   * structural rule. Entity-DECODED plain text (`&lt;script&gt;` arrives as the literal
   * `<script>`): never render as raw HTML (React escaping only; no dangerouslySetInnerHTML
   * or string-built HTML).
   */
  siteName: string;
  /**
   * May hold an individual's name. Do not store or display except under an explicit
   * structural rule. Entity-DECODED plain text (`&lt;script&gt;` arrives as the literal
   * `<script>`): never render as raw HTML (React escaping only; no dangerouslySetInnerHTML
   * or string-built HTML).
   */
  permittee: string;
  sic?: string;
  segment?: string;
  county?: string;
  city?: string;
}

export interface TceqSummary {
  permitNumber: string;
  status?: string;
  coverageBegan?: string;
  /**
   * May hold an individual's name. Do not store or display except under an explicit
   * structural rule. Entity-DECODED plain text (`&lt;script&gt;` arrives as the literal
   * `<script>`): never render as raw HTML (React escaping only; no dangerouslySetInnerHTML
   * or string-built HTML).
   */
  siteName?: string;
  sic?: string;
  areaDisturbedAcres?: number;
  estimatedStart?: string;
  estimatedEnd?: string;
  receivingWater?: string;
  segment?: string;
  /**
   * May hold an individual's name. Do not store or display except under an explicit
   * structural rule. Entity-DECODED plain text (`&lt;script&gt;` arrives as the literal
   * `<script>`): never render as raw HTML (React escaping only; no dangerouslySetInnerHTML
   * or string-built HTML).
   */
  operatorName?: string;
  county?: string;
  lat?: number;
  lon?: number;
}

export interface TceqCriteria {
  /** Set exactly one of these; both or neither throws. */
  permitStatus?: string;
  appStatus?: string;
  county?: string;
  principal?: string;
  siteName?: string;
  sicCode?: string;
  /** MM/DD/YYYY or ISO; the start/end date fields of TCEQ's search form. */
  startDate?: string;
  endDate?: string;
}

export interface TceqSessionDeps {
  fetch?: typeof fetch;
  rateGate?: () => Promise<void>;
  timeoutMs?: number;
}

/** The rate gate belongs to one session: two sessions each run their own 1 req/s. */
export interface TceqSession {
  get(url: string, opts?: { cookies?: boolean }): Promise<string>;
  post(url: string, body: string): Promise<string>;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function cleanText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** MM/DD/YYYY -> YYYY-MM-DD, or undefined when not a real calendar date. */
export function usDateToIso(s: string | undefined): string | undefined {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(s ?? "");
  if (!m) return undefined;
  const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** YYYY-MM-DD -> MM/DD/YYYY, or undefined when malformed. */
export function isoToUsDate(s: string | undefined): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  return m && usDateToIso(`${m[2]}/${m[3]}/${m[1]}`) ? `${m[2]}/${m[3]}/${m[1]}` : undefined;
}

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export type TceqErrorKind = "http" | "redirect" | "off_origin" | "too_large" | "timeout" | "network" | "parse";

/**
 * Every request/parse failure the client raises. `permanent` is true for HTTP 404 and 410
 * ONLY. Everything else is transient: a redirect may be a maintenance page, a parse failure
 * may be a 200 challenge page, and TCEQ responses set Cloudflare's `__cf_bm` bot-management
 * cookie (seen 2026-11-13), so a 401/403 is more likely a bot wall than a gone page. Messages
 * carry no page content.
 */
export class TceqRequestError extends Error {
  readonly kind: TceqErrorKind;
  readonly status?: number;
  readonly permanent: boolean;
  constructor(kind: TceqErrorKind, message: string, status?: number) {
    super(message);
    this.name = "TceqRequestError";
    this.kind = kind;
    this.status = status;
    this.permanent = kind === "http" && (status === 404 || status === 410);
  }
}

/** The search matched more pages than allowed: the caller should narrow the date range. */
export class TceqNarrowSearchError extends Error {
  constructor(
    readonly reported: number,
    readonly pages: number,
    readonly maxPages: number,
  ) {
    super(`TCEQ search reported ${reported} records over ${pages} pages (maxPages ${maxPages}): narrow the search`);
    this.name = "TceqNarrowSearchError";
  }
}

function assertTceqOrigin(url: string): void {
  if (new URL(url).origin !== ORIGIN) throw new TceqRequestError("off_origin", `refusing off-origin TCEQ request: ${new URL(url).origin}`);
}

/** Maps a thrown fetch/read failure to a typed error (aborts and timeouts are `timeout`, the rest `network`). */
function transportError(err: unknown): TceqRequestError {
  if (err instanceof TceqRequestError) return err;
  const name = err instanceof Error ? err.name : "";
  return name === "TimeoutError" || name === "AbortError"
    ? new TceqRequestError("timeout", "TCEQ request timed out")
    : new TceqRequestError("network", "TCEQ request failed: network error");
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new TceqRequestError("too_large", `TCEQ response too large (${declared} bytes)`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read().catch((err: unknown) => {
      throw transportError(err);
    });
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new TceqRequestError("too_large", `TCEQ response exceeded ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createTceqSession(deps: TceqSessionDeps = {}): TceqSession {
  const doFetch = deps.fetch ?? fetch;
  const gate = deps.rateGate ?? createRateGate(1);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const jar = new Map<string, string>();

  async function request(url: string, init: RequestInit, useCookies: boolean): Promise<string> {
    assertTceqOrigin(url);
    await gate();
    const headers: Record<string, string> = { "user-agent": USER_AGENT, ...(init.headers as Record<string, string>) };
    if (useCookies && jar.size > 0) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await doFetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }).catch((err: unknown) => {
      throw transportError(err);
    });
    const drop = () => res.body?.cancel().catch(() => {});
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      await drop();
      throw new TceqRequestError("redirect", `TCEQ request redirected (HTTP ${res.status}) for ${new URL(url).pathname}`, res.status);
    }
    if (res.url && new URL(res.url).origin !== ORIGIN) {
      await drop();
      throw new TceqRequestError("off_origin", `TCEQ response from off-origin ${new URL(res.url).origin}`);
    }
    if (!res.ok) {
      await drop();
      throw new TceqRequestError("http", `TCEQ request failed: HTTP ${res.status} for ${new URL(url).pathname}`, res.status);
    }
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0];
      const eq = pair.indexOf("=");
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return readCapped(res);
  }

  return {
    get: (url, opts) => request(url, { method: "GET" }, opts?.cookies !== false),
    post: (url, body) =>
      request(url, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } }, true),
  };
}

// The image-submit button's NAME contains '='; a naive name=value split breaks it
// and the search silently returns the form instead of results.
const IMAGE_SUBMIT = encodeURIComponent("_fuseaction=home.validate_search_crit");

export function buildSearchBody(criteria: TceqCriteria): string {
  if ((criteria.permitStatus !== undefined && criteria.permitStatus !== "") === (criteria.appStatus !== undefined && criteria.appStatus !== "")) throw new Error("set exactly one of permitStatus or appStatus");
  const fields: [string, string][] = [
    ["newsearch", "yes"],
    ["goto", "search"],
    ["permitStatusList", "ACTIVE,DENIED,EXPIRED,TERMINATED,WITHDRAWN"],
    ["appStatusList", "APPROVED,PENDING,DENIED,WITHDRAWN"],
    ["permit_type", "SWC|Construction Notice of Intent (TXR15)"],
  ];
  if (criteria.appStatus) fields.push(["app_status", criteria.appStatus]);
  else fields.push(["permit_status", criteria.permitStatus as string]);
  const optional: [string, string | undefined][] = [
    ["cnty_name", criteria.county],
    ["princ_name", criteria.principal],
    ["phys_name", criteria.siteName],
    ["sic_code", criteria.sicCode],
    ["start_date", isoToUsDate(criteria.startDate) ?? criteria.startDate],
    ["end_date", isoToUsDate(criteria.endDate) ?? criteria.endDate],
  ];
  for (const [k, v] of optional) if (v) fields.push([k, v]);
  const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, "+");
  return [...fields.map(([k, v]) => `${enc(k)}=${enc(v)}`), `${IMAGE_SUBMIT}.x=5`, `${IMAGE_SUBMIT}.y=5`].join("&");
}

// TCEQ's real empty-search page has no count line, only this message.
const NO_RESULTS_RE = /There\s+were\s+no\s+permits\s+found\s+that\s+match\s+the\s+search\s+criteria\s+provided/i;

const MAX_ROW_CELLS = 40;

const EXPECTED_HEADERS = ["Auth #", "Site Name", "Permittee", "SIC Code", "Segment #", "County", "Region", "City", "Site Location"];

/**
 * `dropped` counts result rows whose link is not a TCEQ summary URL: they are not returned
 * (nothing to fetch) but still count toward the page-walk completeness check.
 */
export function parseResultsPage(html: string): { reported?: number; rows: TceqRow[]; dropped: number } {
  const m = /Your search returned\s+(\d[\d,]*)\s+records?/i.exec(html);
  const reported = m ? Number(m[1].replace(/,/g, "")) : NO_RESULTS_RE.test(html) ? 0 : undefined;
  const rows: TceqRow[] = [];
  let dropped = 0;
  let headerSeen = false;
  for (const tr of html.split(/<tr[\s>]/i).slice(1)) {
    if (/<th[\s>]/i.test(tr)) {
      const headers = [...tr.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((c) => cleanText(c[1]));
      if (headers.join("|") !== EXPECTED_HEADERS.join("|")) {
        throw new TceqRequestError("parse", `TCEQ results columns changed (${headers.length} header cells)`);
      }
      headerSeen = true;
      continue;
    }
    const link = /<a\s[^>]*href="([^"]*fuseaction=home\.permit_summary[^"]*)"/i.exec(tr);
    if (!link) continue;
    if (!headerSeen) throw new TceqRequestError("parse", "TCEQ results rows appeared before a header row");
    if ((tr.match(/<td[\s>]/gi) ?? []).length > MAX_ROW_CELLS) {
      throw new TceqRequestError("parse", `TCEQ results row has more than ${MAX_ROW_CELLS} cells`);
    }
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => cleanText(c[1]));
    if (cells.length !== EXPECTED_HEADERS.length) {
      throw new TceqRequestError("parse", `TCEQ results row has ${cells.length} cells, expected ${EXPECTED_HEADERS.length}`);
    }
    const [permitNumber, siteName, permittee, sic, segment, county, , city] = cells; // cells[8] = free-text Site Location, dropped on purpose
    if (!permitNumber) throw new TceqRequestError("parse", "TCEQ results row has an empty Auth #");
    let summaryUrl: string;
    try {
      summaryUrl = assertSummaryUrl(decodeEntities(link[1]), INDEX_URL).href;
    } catch {
      dropped++;
      continue;
    }
    rows.push({
      permitNumber,
      summaryUrl,
      siteName,
      permittee,
      ...(sic ? { sic } : {}),
      ...(segment ? { segment } : {}),
      ...(county ? { county } : {}),
      ...(city ? { city } : {}),
    });
  }
  return { reported, rows, dropped };
}

/** TCEQ repeats a permit row several times per page; keep the first of each. */
export function dedupeByPermit(rows: TceqRow[]): TceqRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.permitNumber) ? false : (seen.add(r.permitNumber), true)));
}

/** Returns the RAW rows (TCEQ repeats permits); dedupe with {@link dedupeByPermit}. */
export async function searchTxr15(
  session: TceqSession,
  criteria: TceqCriteria,
  opts: { maxPages?: number } = {},
): Promise<{ reported: number; rows: TceqRow[]; droppedRows: number }> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  await session.get(FORM_URL);
  const first = parseResultsPage(await session.post(INDEX_URL, buildSearchBody(criteria)));
  if (first.reported === undefined) throw new TceqRequestError("parse", "TCEQ results page has no record count (form re-served?)");
  const reported = first.reported;
  if (reported === 0) return { reported: 0, rows: [], droppedRows: 0 };
  const pages = Math.ceil(reported / PAGE_SIZE);
  if (pages > maxPages) {
    throw new TceqNarrowSearchError(reported, pages, maxPages);
  }
  const rows = [...first.rows];
  let droppedRows = first.dropped;
  for (let page = 2; page <= pages; page++) {
    const html = await session.get(`${INDEX_URL}?CurrentPage=${page}&fuseaction=home.permit_list&sort=lgl_ident_txt`);
    const parsed = parseResultsPage(html);
    rows.push(...parsed.rows);
    droppedRows += parsed.dropped;
  }
  // A truncated page set is indistinguishable from a complete one without this check.
  if (rows.length + droppedRows !== reported) {
    throw new TceqRequestError("parse", `TCEQ page walk returned ${rows.length + droppedRows} rows but the search reported ${reported}`);
  }
  return { reported, rows, droppedRows };
}

function summaryLines(html: string): string[] {
  const body = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  // Block-level tags break lines; inline ones (font, span, b...) must not split a label from its colon.
  return decodeEntities(body.replace(/<\/?(?:br|p|label|tr|td|th|div|li|ul|h\d|legend|fieldset|form|table|body|html|head|title)\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, " "))
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** First "Label : value" occurrence; the value may sit on the next line. */
function field(lines: string[], label: string): string | undefined {
  const re = new RegExp(`^${label}\\s*:\\s*(.*)$`, "i");
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const next = lines[i + 1];
    const v = m[1] || (next && !/^[^:]{1,40}:/.test(next) ? next : "");
    return v || undefined;
  }
  return undefined;
}

function num(s: string | undefined): number | undefined {
  if (s === undefined || !/^-?\d+(\.\d+)?$/.test(s)) return undefined;
  return Number(s);
}

export function parseSummaryPage(html: string, url: string): TceqSummary {
  const lines = summaryLines(html);
  const permitNumber = field(lines, "Permit Number");
  if (!permitNumber) throw new TceqRequestError("parse", `TCEQ summary page has no Permit Number (${new URL(url).search})`);
  // First lat/lon block only (Permitted Site); the Regulated Entity block repeats them as 0/0.
  let lat = num(field(lines, "Latitude"));
  let lon = num(field(lines, "Longitude"));
  const valid =
    lat !== undefined && lon !== undefined && Number.isFinite(lat) && Number.isFinite(lon) &&
    lat !== 0 && lon !== 0 && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  if (!valid) lat = lon = undefined;
  const operator = field(lines, "Operator")?.replace(/^CN\d+\s*-\s*/, "");
  const out: TceqSummary = { permitNumber };
  const set = <K extends keyof TceqSummary>(k: K, v: TceqSummary[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set("status", field(lines, "Authorization Status"));
  set("coverageBegan", usDateToIso(field(lines, "Date Coverage Began")));
  set("siteName", field(lines, "Site Name on Permit"));
  set("sic", field(lines, "Primary SIC Code"));
  set("areaDisturbedAcres", num(field(lines, "Area Disturbed \\(in Acres\\)")));
  set("estimatedStart", usDateToIso(field(lines, "estimated project start date")));
  set("estimatedEnd", usDateToIso(field(lines, "estimated project end date")));
  set("receivingWater", field(lines, "receiving water body"));
  set("segment", field(lines, "segment number"));
  set("operatorName", operator);
  set("county", field(lines, "County"));
  set("lat", lat);
  set("lon", lon);
  return out;
}

/** WHATWG parsing lowercases the host, so an uppercase-host URL is accepted (it names the same origin). */
export function assertSummaryUrl(url: string, base?: string): URL {
  const u = new URL(url, base);
  if (
    u.origin !== ORIGIN ||
    u.username !== "" ||
    u.password !== "" ||
    u.port !== "" ||
    u.pathname !== INDEX_PATH ||
    u.searchParams.getAll("fuseaction").length !== 1 ||
    u.searchParams.get("fuseaction") !== "home.permit_summary"
  ) {
    throw new TceqRequestError("off_origin", `refusing to fetch non-TCEQ-summary URL: ${u.origin}${u.pathname}`);
  }
  return u;
}

export async function fetchTxr15Summary(session: TceqSession, url: string): Promise<TceqSummary> {
  const u = assertSummaryUrl(url);
  // The summary loads without a session cookie; send none.
  return parseSummaryPage(await session.get(u.href, { cookies: false }), u.href);
}
