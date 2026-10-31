/**
 * Citation readability audit, PHASE 1: a deterministic, offline report that maps
 * every cited source URL and buckets it so phase 2 (an Ollama bench on
 * hand-labelled pages) knows what to test. No model, no network, no DB.
 *
 * ⛔ THIS SCRIPT DOES NOT DECIDE READABILITY. Ed's citation rule (2026-10-27):
 * cite only sources a visitor who is NOT logged in or subscribed can open and
 * read (visible metered text counts; a bot-blocked but free site counts via an
 * Internet Archive copy; hard paywalls, subscriber-only blocks and dead links
 * with no archive copy are excluded). "The quote is in the fetched HTML" is NOT
 * readability: paywalled CMSs ship the full text inside hidden subscriber
 * blocks. Nothing here fetches a page, so nothing here can see that. The
 * buckets below rank and group; only the curated host list carries a verdict,
 * and only for hosts a human already inspected.
 *
 * BUCKET PRECEDENCE (first match wins, per URL):
 *   1. non_document                 `isNonDocumentSource` (OSM, ArcGIS, geocoders)
 *   2. archive                      web.archive.org / archive.org copies
 *   3. pdf                          URL path ends in .pdf
 *   4. known_excluded               curated host list (KNOWN_HOSTS)
 *   5. known_marker_false_positive  curated host list (KNOWN_HOSTS)
 *   6. unclassified                 everything else
 * Archive outranks the curated list on purpose: an archive.org copy of an
 * excluded host's page is a different URL whose readability is not checked here.
 *
 * HOSTS, NOT REGISTRABLE DOMAINS. Hosts are lowercased with a leading `www.`
 * stripped. There is no public-suffix list in the repo, so `a.example.com` and
 * `b.example.com` count as two hosts, and counts here run higher than any
 * "domains" figure.
 *
 * `Source` (lib/schema.ts) has no archive or alternate URL field: the only URL
 * a source carries is `url`, so archive copies appear only as sources whose
 * `url` is itself an archive.org link.
 *
 * Usage:
 *   npx tsx scripts/citation-readability-report.ts \
 *     [--facilities <path>] [--liveness <path>] [--out-dir <dir>]
 * Defaults: data/facilities.json; the newest discovery-logs/source-health-*.json
 * if one exists (else "liveness: not joined"); out-dir discovery-logs/ (gitignored).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isNonDocumentSource } from "./discovery/non-document-source";
import { isEntrypoint } from "./is-entrypoint";

// --- Types ---------------------------------------------------------------

export type Bucket =
  | "non_document"
  | "archive"
  | "pdf"
  | "known_excluded"
  | "known_marker_false_positive"
  | "unclassified";

export const BUCKETS: readonly Bucket[] = [
  "non_document",
  "archive",
  "pdf",
  "known_excluded",
  "known_marker_false_positive",
  "unclassified",
];

export interface SourceLike {
  url: string;
  kind?: string;
}

export interface FacilityLike {
  id: string;
  name?: string;
  sources: SourceLike[];
}

/** Subset of scripts/discovery/check-sources.ts's `SourceCheckResult` this report reads. */
export interface LivenessResult {
  url: string;
  classification: string;
  httpStatus?: number | null;
  errorCode?: string;
}

export interface KnownHost {
  host: string;
  verdict: "known_excluded" | "known_marker_false_positive";
  reason: string;
  provenance: string;
}

// --- Curated host list ------------------------------------------------------

/**
 * SMALL on purpose. Each entry is a HOST-WIDE bucket extrapolated from a human
 * look at one or a few pages, NOT a per-URL verdict: a host can serve both
 * readable and walled pages. The follow-up Ollama bench must test URLs individually. Hosts were
 * checked against the URLs actually present in data/facilities.json
 * (2026-10-29). Not seeded: a Cleanview host other than `cleanview.co` (none
 * other appears in the dataset). `reason` is an observation, not a present-tense
 * readability fact.
 */
export const KNOWN_HOSTS: readonly KnownHost[] = [
  {
    host: "hanfordsentinel.com",
    verdict: "known_excluded",
    reason: "Observed 2026-10-27/28 (research2 wave): a cited quote sat in a `subscriber-only` block hidden with display:none.",
    provenance: "research2 wave, 2026-10-27/28",
  },
  {
    host: "arkansasonline.com",
    verdict: "known_excluded",
    reason: "Observed 2026-10-28 (research3 verifier, Jefferson Power Station source 2): hard paywall; the cited figure was not readable.",
    provenance: "research3 verifier, 2026-10-28",
  },
  {
    host: "cleanview.co",
    verdict: "known_excluded",
    reason: "Recorded 2026-10-28 (research3, Gibson record): the cited figure could not be read there and was checkable only on a different, free site; recorded at the time as a paid source.",
    provenance: "research3, 2026-10-28",
  },
  {
    host: "pinalpost.com",
    verdict: "known_marker_false_positive",
    reason: 'Recorded 2026-10-27/28 (research2 wave) as a false positive: "premium"/"locked" strings traced to an SEO plugin and an email decoder. String-level only; not a rendered visibility test.',
    provenance: "research2 wave, 2026-10-27/28",
  },
  {
    host: "measuredai.substack.com",
    verdict: "known_marker_false_positive",
    reason: 'Recorded 2026-10-27/28 (research2 wave) as a false positive: "paywall" strings traced to config flags. String-level only; not a rendered visibility test.',
    provenance: "research2 wave, 2026-10-27/28",
  },
  {
    host: "idahostatejournal.com",
    verdict: "known_marker_false_positive",
    reason: "Recorded 2026-10-27/28 (research2 wave) as a false positive: `subscriber-premium` wrapper, recorded as metered. String-level only; not a rendered visibility test.",
    provenance: "research2 wave, 2026-10-27/28",
  },
];

// --- Pure functions ------------------------------------------------------------

/** Lowercased hostname with a leading `www.` stripped; null when unparseable. */
export function normalizeHost(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.startsWith("www.") ? h.slice(4) : h;
  } catch {
    return null;
  }
}

function hostIsOrUnder(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function isArchiveUrl(url: string): boolean {
  const host = normalizeHost(url);
  return host !== null && (host === "archive.org" || hostIsOrUnder(host, "archive.org") || host === "archive.ph" || host === "archive.is" || host === "archive.today");
}

export function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

export function knownHostFor(host: string): KnownHost | undefined {
  return KNOWN_HOSTS.find((k) => hostIsOrUnder(host, k.host));
}

export function bucketFor(source: SourceLike): Bucket {
  if (isNonDocumentSource(source)) return "non_document";
  if (isArchiveUrl(source.url)) return "archive";
  if (isPdfUrl(source.url)) return "pdf";
  const host = normalizeHost(source.url);
  const known = host === null ? undefined : knownHostFor(host);
  if (known) return known.verdict;
  return "unclassified";
}

/** Worst-first ordering so a URL checked more than once keeps its most severe result. */
const LIVENESS_SEVERITY = [
  "gone",
  "error",
  "timeout",
  "server_error",
  "client_error",
  "blocked",
  "bot_blocked",
  "throttled",
  "redirected",
  "ok",
];

export function joinLiveness(results: LivenessResult[]): Map<string, LivenessResult> {
  const byUrl = new Map<string, LivenessResult>();
  const rank = (c: string): number => {
    const i = LIVENESS_SEVERITY.indexOf(c);
    return i === -1 ? LIVENESS_SEVERITY.length : i;
  };
  for (const r of results) {
    const prev = byUrl.get(r.url);
    if (!prev || rank(r.classification) < rank(prev.classification)) byUrl.set(r.url, r);
  }
  return byUrl;
}

/**
 * "Dead" = a genuine 404/410/451, or a DNS NXDOMAIN. bot_blocked, throttled,
 * timeouts and 5xx are NOT dead: they are what phase 2 must sort out.
 */
export function isDead(r: LivenessResult | undefined): boolean {
  if (!r) return false;
  return r.classification === "gone" || (r.classification === "error" && r.errorCode === "ENOTFOUND");
}

export interface SingleSourceFinding {
  id: string;
  name: string;
  documentSources: number;
  reasons: { url: string; why: "known_excluded" | "dead" }[];
}

export interface SingleSourceResult {
  /** Every document source is known_excluded or dead per liveness. */
  dependent: SingleSourceFinding[];
  /** Facilities whose sources are ALL non_document (the rule has nothing to test). */
  noDocumentSource: { id: string; name: string }[];
}

/**
 * Facilities whose EVERY document source (non_document excluded) is
 * known_excluded or dead per liveness. URLs liveness did not check count as not
 * dead. An archive snapshot is itself a document source in bucket `archive`
 * and is never known_excluded, but liveness is checked on it like any other
 * source: a snapshot that liveness marks gone does NOT clear the facility.
 * Facilities with no document source at all are listed separately, not skipped.
 */
export function singleSourceDependency(
  facilities: FacilityLike[],
  liveness: Map<string, LivenessResult> | null,
): SingleSourceResult {
  const dependent: SingleSourceFinding[] = [];
  const noDocumentSource: SingleSourceResult["noDocumentSource"] = [];
  for (const f of facilities) {
    const docs = f.sources.filter((s) => bucketFor(s) !== "non_document");
    if (docs.length === 0) {
      noDocumentSource.push({ id: f.id, name: f.name ?? f.id });
      continue;
    }
    const reasons: SingleSourceFinding["reasons"] = [];
    for (const s of docs) {
      if (bucketFor(s) === "known_excluded") reasons.push({ url: s.url, why: "known_excluded" });
      else if (liveness && isDead(liveness.get(s.url))) reasons.push({ url: s.url, why: "dead" });
      else break;
    }
    if (reasons.length === docs.length) {
      dependent.push({ id: f.id, name: f.name ?? f.id, documentSources: docs.length, reasons });
    }
  }
  return { dependent, noDocumentSource };
}

export interface HostRow {
  host: string;
  urls: number;
  distinctUrls: number;
  facilities: number;
  bucket: Bucket;
  buckets: Partial<Record<Bucket, number>>;
  liveness?: Record<string, number>;
}

export interface Report {
  generatedAt: string;
  totals: { urls: number; distinctUrls: number; hosts: number; facilities: number; unparseableUrls: number };
  bucketCounts: Record<Bucket, { urls: number; distinctUrls: number }>;
  livenessJoined: boolean;
  livenessSource: string | null;
  livenessCoverage: { distinctUrlsWithResult: number; distinctUrls: number } | null;
  hosts: HostRow[];
  singleSourceDependency: SingleSourceFinding[];
  noDocumentSource: { id: string; name: string }[];
  topUnclassifiedHostsByFacilities: HostRow[];
  knownHosts: readonly KnownHost[];
}

export function buildReport(
  facilities: FacilityLike[],
  liveness: Map<string, LivenessResult> | null,
  livenessSource: string | null = null,
  now: Date = new Date(),
): Report {
  interface Acc {
    urls: number;
    distinct: Set<string>;
    facs: Set<string>;
    buckets: Partial<Record<Bucket, number>>;
    live: Record<string, number>;
  }
  const hosts = new Map<string, Acc>();
  const allDistinct = new Set<string>();
  const bucketCounts = Object.fromEntries(BUCKETS.map((b) => [b, { urls: 0, distinctUrls: 0 }])) as Report["bucketCounts"];
  const bucketDistinct = Object.fromEntries(BUCKETS.map((b) => [b, new Set<string>()])) as Record<Bucket, Set<string>>;
  let total = 0;
  let unparseable = 0;
  const seenFacilities = new Set<string>();

  for (const f of facilities) {
    seenFacilities.add(f.id);
    for (const s of f.sources) {
      total++;
      allDistinct.add(s.url);
      const bucket = bucketFor(s);
      bucketCounts[bucket].urls++;
      bucketDistinct[bucket].add(s.url);
      const host = normalizeHost(s.url);
      if (host === null) {
        unparseable++;
        continue;
      }
      let a = hosts.get(host);
      if (!a) {
        a = { urls: 0, distinct: new Set(), facs: new Set(), buckets: {}, live: {} };
        hosts.set(host, a);
      }
      a.urls++;
      a.distinct.add(s.url);
      a.facs.add(f.id);
      a.buckets[bucket] = (a.buckets[bucket] ?? 0) + 1;
      if (liveness) {
        const r = liveness.get(s.url);
        const key = r ? r.classification : "not_checked";
        a.live[key] = (a.live[key] ?? 0) + 1;
      }
    }
  }
  for (const b of BUCKETS) bucketCounts[b].distinctUrls = bucketDistinct[b].size;

  const rows: HostRow[] = [...hosts.entries()].map(([host, a]) => {
    const known = knownHostFor(host);
    const dominant = (Object.entries(a.buckets) as [Bucket, number][]).sort((x, y) => y[1] - x[1])[0][0];
    const row: HostRow = {
      host,
      urls: a.urls,
      distinctUrls: a.distinct.size,
      facilities: a.facs.size,
      bucket: known && a.buckets[known.verdict] ? known.verdict : dominant,
      buckets: a.buckets,
    };
    if (liveness) row.liveness = a.live;
    return row;
  });
  rows.sort((x, y) => y.urls - x.urls || x.host.localeCompare(y.host));

  const top = rows
    .filter((r) => (r.buckets.unclassified ?? 0) > 0)
    .sort((x, y) => y.facilities - x.facilities || y.urls - x.urls || x.host.localeCompare(y.host))
    .slice(0, 50);

  const single = singleSourceDependency(facilities, liveness);

  return {
    generatedAt: now.toISOString(),
    totals: {
      urls: total,
      distinctUrls: allDistinct.size,
      hosts: hosts.size,
      facilities: seenFacilities.size,
      unparseableUrls: unparseable,
    },
    bucketCounts,
    livenessJoined: liveness !== null,
    livenessSource,
    livenessCoverage: liveness
      ? { distinctUrlsWithResult: [...allDistinct].filter((u) => liveness.has(u)).length, distinctUrls: allDistinct.size }
      : null,
    hosts: rows,
    singleSourceDependency: single.dependent,
    noDocumentSource: single.noDocumentSource,
    topUnclassifiedHostsByFacilities: top,
    knownHosts: KNOWN_HOSTS,
  };
}

// --- Markdown ----------------------------------------------------------------------

/** The 2026-10-28 note's figures, kept only to print a delta. */
export const NOTE_URLS = 8769;
export const NOTE_DOMAINS = 2208;

function fmtMap(m: Record<string, number> | undefined): string {
  if (!m) return "";
  return Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

export function renderMarkdown(r: Report, hostRowLimit = 100): string {
  const L: string[] = [];
  const t = r.totals;
  L.push("# Citation readability report (phase 1)", "");
  L.push(`Generated ${r.generatedAt}. Deterministic and offline: **this report does not decide readability.** It buckets and ranks URLs so phase 2 knows what to test. "In the fetched HTML" is not "visible to a logged-out reader".`, "");
  L.push("## Headline numbers", "");
  L.push(`- Facilities: ${t.facilities}`);
  L.push(`- Source URLs (total): ${t.urls}`);
  L.push(`- Distinct URLs: ${t.distinctUrls}`);
  L.push(`- Distinct hosts: ${t.hosts} (**hosts, not registrable domains**: \`www.\` stripped, no public-suffix list, so \`a.x.com\` and \`b.x.com\` count separately)`);
  if (t.unparseableUrls) L.push(`- Unparseable URLs: ${t.unparseableUrls}`);
  L.push(
    `- The 2026-10-28 note said ${NOTE_URLS} URLs / ${NOTE_DOMAINS} domains. This run: ${t.urls} URLs (${t.urls - NOTE_URLS >= 0 ? "+" : ""}${t.urls - NOTE_URLS}) / ${t.hosts} hosts (${t.hosts - NOTE_DOMAINS >= 0 ? "+" : ""}${t.hosts - NOTE_DOMAINS}).`,
    "",
  );
  L.push("## Buckets", "", "known_marker_false_positive: hosts whose paywall-like markup was recorded as a false positive during a data wave; a string-level judgement, not a rendered visibility test.", "", "Precedence, first match wins: non_document, archive, pdf, known_excluded / known_marker_false_positive, unclassified.", "");
  L.push("| bucket | urls | distinct urls |", "|---|---:|---:|");
  for (const b of BUCKETS) L.push(`| ${b} | ${r.bucketCounts[b].urls} | ${r.bucketCounts[b].distinctUrls} |`);
  L.push("");
  L.push("## Liveness", "");
  if (r.livenessJoined && r.livenessCoverage) {
    L.push(`Joined from \`${r.livenessSource}\`: ${r.livenessCoverage.distinctUrlsWithResult} of ${r.livenessCoverage.distinctUrls} distinct URLs have a result; the rest read \`not_checked\`. A URL checked more than once keeps its most severe result.`, "");
  } else {
    L.push("liveness: not joined", "");
  }
  L.push("## Curated host list", "", "| host | verdict | reason | provenance |", "|---|---|---|---|");
  for (const k of r.knownHosts) {
    const seen = r.hosts.find((h) => h.host === k.host || h.host.endsWith(`.${k.host}`));
    L.push(`| ${k.host}${seen ? ` (${seen.urls} urls)` : " (absent from dataset)"} | ${k.verdict} | ${k.reason} | ${k.provenance} |`);
  }
  L.push("");
  L.push(`## Single-source dependency (${r.singleSourceDependency.length} facilities)`, "");
  L.push("Facilities with no non-excluded, non-dead document source: every document source is known_excluded, or dead per liveness (gone / ENOTFOUND). URLs liveness did not check count as not dead; an archive.org source counts as a document source that is not excluded or dead; archive readability is not checked here.", "");
  if (!r.livenessJoined) L.push("Liveness not joined, so only the known_excluded rule applies.", "");
  const esc = (x: string): string => x.replace(/\|/g, "/");
  if (r.singleSourceDependency.length) {
    L.push("| facility | id | doc sources | why |", "|---|---|---:|---|");
    for (const f of r.singleSourceDependency) {
      L.push(`| ${esc(f.name)} | ${f.id} | ${f.documentSources} | ${f.reasons.map((x) => `${x.why}: ${esc(x.url)}`).join("<br>")} |`);
    }
    L.push("");
  }
  L.push(`## No document source (${r.noDocumentSource.length} facilities)`, "");
  L.push("Every source is non_document (map or GIS endpoints), so the rule above had nothing to test.", "");
  if (r.noDocumentSource.length) {
    L.push("| facility | id |", "|---|---|");
    for (const f of r.noDocumentSource) L.push(`| ${esc(f.name)} | ${f.id} |`);
    L.push("");
  }
  L.push("## Top 50 unclassified hosts by facility count (phase 2 labelling candidates)", "");
  L.push("| host | facilities | urls | unclassified urls |", "|---|---:|---:|---:|");
  for (const h of r.topUnclassifiedHostsByFacilities) L.push(`| ${h.host} | ${h.facilities} | ${h.urls} | ${h.buckets.unclassified ?? 0} |`);
  L.push("");
  L.push(`## Per-host table (top ${Math.min(hostRowLimit, r.hosts.length)} of ${r.hosts.length} by URL count; full table in the JSON)`, "");
  L.push(`| host | urls | facilities | bucket | ${r.livenessJoined ? "liveness" : "buckets"} |`, "|---|---:|---:|---|---|");
  for (const h of r.hosts.slice(0, hostRowLimit)) {
    L.push(`| ${h.host} | ${h.urls} | ${h.facilities} | ${h.bucket} | ${r.livenessJoined ? fmtMap(h.liveness) : fmtMap(h.buckets)} |`);
  }
  L.push("");
  return L.join("\n");
}

// --- CLI -------------------------------------------------------------------------------

export interface CliArgs {
  facilities: string;
  liveness: string | null;
  outDir: string;
}

export function parseArgs(argv: string[], cwd: string = process.cwd()): CliArgs {
  const args: CliArgs = {
    facilities: path.join(cwd, "data", "facilities.json"),
    liveness: null,
    outDir: path.join(cwd, "discovery-logs"),
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--facilities" || flag === "--liveness" || flag === "--out-dir") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--facilities") args.facilities = path.resolve(cwd, v);
      else if (flag === "--liveness") args.liveness = path.resolve(cwd, v);
      else args.outDir = path.resolve(cwd, v);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

/** Newest `source-health-*.json` in `dir` (timestamped names sort lexically), or null. */
export function latestLivenessReport(dir: string): string | null {
  try {
    const names = readdirSync(dir).filter((n) => /^source-health-.*\.json$/.test(n)).sort();
    return names.length ? path.join(dir, names[names.length - 1]) : null;
  } catch {
    return null;
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const facilities = JSON.parse(readFileSync(args.facilities, "utf8")) as FacilityLike[];
  const livenessPath = args.liveness ?? latestLivenessReport(args.outDir);
  let liveness: Map<string, LivenessResult> | null = null;
  if (livenessPath) {
    const raw = JSON.parse(readFileSync(livenessPath, "utf8")) as { results?: LivenessResult[] };
    if (!Array.isArray(raw.results)) throw new Error(`${livenessPath}: no results[] array`);
    liveness = joinLiveness(raw.results);
  }
  const report = buildReport(facilities, liveness, livenessPath);
  mkdirSync(args.outDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(args.outDir, `citation-readability-${stamp}.json`);
  const mdPath = path.join(args.outDir, `citation-readability-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, renderMarkdown(report));
  console.log(`wrote ${jsonPath}\nwrote ${mdPath}`);
  console.log(`urls=${report.totals.urls} distinct=${report.totals.distinctUrls} hosts=${report.totals.hosts} facilities=${report.totals.facilities}`);
  console.log(livenessPath ? `liveness joined: ${livenessPath}` : "liveness: not joined");
}

if (isEntrypoint(import.meta.url)) main();
