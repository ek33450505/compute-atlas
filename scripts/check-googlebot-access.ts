/**
 * Googlebot-access canary: asks Google Search Console what it actually saw
 * the last time it crawled a fixed set of canary URLs, and fails LOUDLY if
 * any of them come back blocked.
 *
 * Why this exists (measured 2026-09-08): Cloudflare returned HTTP 403 to
 * Googlebot for roughly five days (2026-07-31 to 2026-08-04). Five state hubs
 * are still frozen in Google's index as "Blocked due to access forbidden
 * (403)". Nothing detected it at the time — the sitemap status stayed Valid
 * with 0 errors, `npm run check:drift` stayed green, CI stayed green —
 * because none of those signals ever ask Google what it actually saw when it
 * crawled. Cloudflare has 403'd Googlebot on this property before (see
 * `compute-atlas-cloudflare-crawler-403-s94` in agent memory). This script
 * closes that gap by reading the ground truth directly from the URL
 * Inspection API.
 *
 * `Discovered - currently not indexed` and `URL is unknown to Google` are
 * NORMAL crawl-budget states, not failures — a young or low-priority page can
 * sit in either state indefinitely with no access problem at all. Do not
 * treat them as blocked; see `isBlocked()` below. This is the single easiest
 * thing to get wrong when reading URL Inspection output.
 *
 * Auth: stdlib + existing deps only, no `googleapis` package. Reads a
 * service-account JSON, hand-builds and RS256-signs a JWT with
 * `node:crypto`, and exchanges it for an OAuth access token via
 * `https://oauth2.googleapis.com/token` (the standard Google service-account
 * "two-legged OAuth" flow — see
 * https://developers.google.com/identity/protocols/oauth2/service-account).
 * Scope: `https://www.googleapis.com/auth/webmasters.readonly`.
 *
 * Credentials, in priority order:
 *   1. `GSC_SERVICE_ACCOUNT_JSON` — the JSON content itself (for CI secrets).
 *   2. `GSC_CREDENTIALS_PATH`, or its default `~/.config/gsc-mcp/service-account.json`
 *      (where it already lives on the maintainer's machine for the GSC MCP).
 * If neither resolves to a readable credential, this prints a skip notice
 * and exits 0 — a missing credential must never turn CI red on its own; that
 * would just be a second, differently-shaped blind spot.
 *
 * Rate limits: the URL Inspection API allows 600 queries/minute and
 * 2000/day. Six canary URLs, called sequentially (never in parallel), is
 * nowhere near either ceiling.
 *
 * Run: npm run check:googlebot (reads GSC_CREDENTIALS_PATH / the default)
 * Or:  npx tsx scripts/check-googlebot-access.ts (CI, reads GSC_SERVICE_ACCOUNT_JSON)
 *
 * Uses relative imports, matching the other scripts in this folder.
 */
import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SITE_URL = "sc-domain:compute-atlas.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const INSPECT_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const DEFAULT_CREDENTIALS_PATH = join(homedir(), ".config", "gsc-mcp", "service-account.json");

// One canary per route family, so a site-wide (or family-scoped) block is
// caught regardless of which part of the route tree it lands on.
export const CANARY_URLS = [
  "https://www.compute-atlas.com/",
  "https://www.compute-atlas.com/states/texas",
  "https://www.compute-atlas.com/operators/qts-data-centers",
  "https://www.compute-atlas.com/facilities/stargate-abilene-tx",
  "https://www.compute-atlas.com/metros/northern-virginia",
  "https://www.compute-atlas.com/table",
];

// Blocked-family pageFetchState values. Anything outside this set (e.g.
// SUCCESSFUL, SOFT_404, NOT_FOUND) is not an access-block symptom.
const BLOCKED_PAGE_FETCH_STATES = new Set([
  "ACCESS_DENIED",
  "ACCESS_FORBIDDEN",
  "BLOCKED_ROBOTS_TXT",
  "BLOCKED_4XX",
]);

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

export interface IndexStatusResult {
  verdict?: string;
  coverageState?: string;
  robotsTxtState?: string;
  pageFetchState?: string;
  lastCrawlTime?: string;
}

export interface InspectionResult {
  inspectionUrl: string;
  indexStatusResult: IndexStatusResult;
}

/**
 * Pure classification — no network. Returns true when the crawl signals
 * above indicate Googlebot was actively BLOCKED from fetching the page, as
 * distinct from the page merely not being indexed (crawl-budget states,
 * which are normal and must never fail this check).
 */
export function isBlocked(result: IndexStatusResult): boolean {
  const coverageState = (result.coverageState ?? "").toLowerCase();
  const coverageBlocked = coverageState.includes("403") || coverageState.includes("blocked");
  const robotsBlocked = result.robotsTxtState === "DISALLOWED";
  const fetchBlocked = result.pageFetchState
    ? BLOCKED_PAGE_FETCH_STATES.has(result.pageFetchState)
    : false;
  return coverageBlocked || robotsBlocked || fetchBlocked;
}

/** Reads and parses the service-account JSON from env content or a file path. Returns null (never throws) when neither source is available; throws a generic error (no input-derived text) if a source is present but malformed — that is a real misconfiguration, not the "no credential" case, and must stay fail-closed. */
export function loadCredentials(
  env: Partial<NodeJS.ProcessEnv> = process.env
): ServiceAccountCredentials | null {
  const raw = env.GSC_SERVICE_ACCOUNT_JSON;
  if (raw) {
    try {
      return JSON.parse(raw) as ServiceAccountCredentials;
    } catch {
      // Deliberately generic: never surface SyntaxError.message or any
      // slice of `raw` — it's private-key material, and GitHub Actions
      // only masks EXACT-match registered secrets. This must still throw
      // (fail-closed) — a malformed credential is a real misconfiguration,
      // not the "no credential" case, and must not fall through to the
      // exit-0 skip path below.
      throw new Error("Failed to parse GSC service-account credentials (malformed JSON) from GSC_SERVICE_ACCOUNT_JSON");
    }
  }
  const path = env.GSC_CREDENTIALS_PATH || DEFAULT_CREDENTIALS_PATH;
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as ServiceAccountCredentials;
    } catch {
      // See comment above: generic message only, still a hard failure.
      throw new Error(`Failed to parse GSC service-account credentials (malformed JSON) from file: ${path}`);
    }
  }
  return null;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Builds and RS256-signs a Google service-account JWT assertion (the "two-legged OAuth" self-signed JWT, not an ID token). */
export function buildSignedJwt(creds: ServiceAccountCredentials, now: number = Math.floor(Date.now() / 1000)): string {
  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: creds.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claimSet))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = base64url(signer.sign(creds.private_key));
  return `${unsigned}.${signature}`;
}

/** Exchanges a signed JWT assertion for a bearer access token. */
export async function fetchAccessToken(creds: ServiceAccountCredentials): Promise<string> {
  const assertion = buildSignedJwt(creds);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error("Token exchange response had no access_token");
  }
  return body.access_token;
}

/** Inspects a single URL against the configured property. */
export async function inspectUrl(accessToken: string, inspectionUrl: string): Promise<InspectionResult> {
  const res = await fetch(INSPECT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inspectionUrl, siteUrl: SITE_URL }),
  });
  if (!res.ok) {
    throw new Error(`URL Inspection failed for ${inspectionUrl}: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { inspectionResult: InspectionResult };
  return body.inspectionResult;
}

async function main(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) {
    console.log(
      "::notice::No GSC service-account credential found (checked GSC_SERVICE_ACCOUNT_JSON and " +
        `GSC_CREDENTIALS_PATH / ${DEFAULT_CREDENTIALS_PATH}) — skipping Googlebot-access canary.`
    );
    process.exit(0);
  }

  const accessToken = await fetchAccessToken(creds);

  let anyBlocked = false;
  for (const url of CANARY_URLS) {
    // Sequential on purpose — the URL Inspection API's 600/min, 2000/day
    // limits don't need six calls run in parallel, and this keeps the
    // failure output ordered and easy to read.
    const result = await inspectUrl(accessToken, url);
    const status = result.indexStatusResult;
    if (isBlocked(status)) {
      anyBlocked = true;
      console.error(
        `::error::Googlebot access blocked for ${url} — coverageState="${status.coverageState}" ` +
          `robotsTxtState="${status.robotsTxtState}" pageFetchState="${status.pageFetchState}" ` +
          `lastCrawlTime="${status.lastCrawlTime}"`
      );
    } else {
      console.log(
        `✓ ${url} — coverageState="${status.coverageState}" lastCrawlTime="${status.lastCrawlTime}"`
      );
    }
  }

  if (anyBlocked) {
    process.exit(1);
  }
  console.log("\n✓ No Googlebot access blocks detected across canary URLs.");
  process.exit(0);
}

// Only run the CLI when this file is executed directly, not when its exports
// are imported by the test suite — matches scripts/check-schema-drift.ts's isMain guard.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error("::error::googlebot access check errored:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
