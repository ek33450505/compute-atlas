import { createHash } from "node:crypto";

import { and, count, eq, gt, min, sql } from "drizzle-orm";

import { checkApiRateLimit } from "@/lib/api-rate-limit";
import { NO_STORE_HEADERS } from "@/lib/api-response";
import { DATASET_EDITION_FILES, DatasetBlobError, getEditionFileText } from "@/lib/dataset-blob";
import type { DatasetEditionFileName } from "@/lib/dataset-blob";
import { latestPublishedEdition } from "@/lib/dataset-editions";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import { getGrantByAccessToken } from "@/lib/dataset-grants";
import { WatermarkError, watermarkCsv, watermarkJsonArray } from "@/lib/dataset-watermark";
import { getDb } from "@/lib/db/client";
import { redactedErrorCode } from "@/lib/db-error";
import { datasetAccessGrantsTable, datasetDownloadsTable, type DatasetDownloadOutcome } from "@/lib/db/schema";
import { extractTrustedClientIp, hashIp, normaliseIpForBucketing } from "@/lib/rate-limit";

/**
 * `GET /api/dataset/file?t=<access token>&f=<file name>`: serves the latest published edition's file to an
 * approved grantee. The route is a thin wrapper; everything is here so the order of the gates is one
 * readable list (and one testable unit):
 *
 *   1. flag off                    -> generic 404
 *   2. per-IP in-memory limit      -> 429, BEFORE any token or DB work (the only bound on unauthenticated
 *                                     traffic: unauthenticated requests never write rows)
 *   3. `f` exactly one allowlisted -> else generic 404 (Blob is never called with a caller-chosen path)
 *   4. `t` resolves to a LIVE grant-> else generic 404 (`getGrantByAccessToken` owns "live"; never read `status`)
 *   5. a published edition exists  -> else generic 404 (nothing logged; the landing page explains it)
 *   6. reserve a `served` row, then count the grant's `served` rows in the last 24 h INCLUDING it; over the cap
 *                                  -> the row becomes `denied_rate` + 429. Reserve-then-count, because
 *                                     count-then-insert lets a burst of concurrent requests all read "29" and
 *                                     all pass.
 *   7-8. fetch + integrity check   -> the row becomes `error` + generic 503 on any failure; a mismatching file
 *                                     is never served
 *   9. watermark (json/csv only)   -> a missing / short secret is a 503, never an unmarked copy; that check
 *                                     runs right after step 5, BEFORE the reserve, so a misconfigured deploy
 *                                     answers 503 without writing a row per request
 *   10. counter bump, then stream the body
 *
 * Any throw after the reserve settles the reserved row to `error` (a 503 must not cost the grantee a unit of cap).
 *
 * From step 6 on the grant is known to be live, so (and only so) rows are written. The token is never logged
 * and never part of an error: every log line below carries a fixed code only.
 *
 * `HEAD` is answered by `handleDatasetHeadRequest`, never by Next's GET-derived default: a prefetcher's HEAD
 * with a valid token would otherwise read Blob, watermark, write a row and spend the daily cap.
 */

/** Per-grant ceiling: 30 `served` rows in any rolling 24 h. Includes every file, so a full edition (5 files) is 6 pulls. */
export const DATASET_GRANT_DAILY_LIMIT = 30;
export const DATASET_GRANT_WINDOW_MS = 24 * 60 * 60 * 1000;

const RATE_BUCKET_PREFIX = "dataset-file:";
/** The two record files are marked per grantee; a secret shorter than this is treated as unset. */
const MIN_WATERMARK_SECRET_LENGTH = 32;
/** Streamed body chunk size. */
export const DATASET_STREAM_CHUNK_BYTES = 64 * 1024;
const EDITION_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CONTENT_TYPES: Record<DatasetEditionFileName, string> = {
  "facilities.json": "application/json; charset=utf-8",
  "facilities.csv": "text/csv; charset=utf-8",
  "siting-context.json": "application/json; charset=utf-8",
  "changelog.json": "application/json; charset=utf-8",
  "README.txt": "text/plain; charset=utf-8",
};

const isAllowlistedFile = (name: string): name is DatasetEditionFileName =>
  (DATASET_EDITION_FILES as readonly string[]).includes(name);

/** Headers every response of this route carries, error or not. */
const BASE_HEADERS = {
  ...NO_STORE_HEADERS,
  "X-Robots-Tag": "noindex",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

/**
 * THE generic 404: one function, so the status, headers and body are byte-identical for every invalid cause
 * (flag off, bad `f`, unknown / malformed / revoked / expired / pending / rejected token, no edition). A
 * second 404 builder would be an oracle.
 */
function notFound(): Response {
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * 429 for either limiter. Built here (not `tooManyRequests`) so it carries the same base headers as every other
 * response of this route: noindex and no-referrer as well as the two no-store directives.
 */
function rateLimited(retryAfter: number): Response {
  return new Response(JSON.stringify({ error: "Too many requests" }), {
    status: 429,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Retry-After": String(retryAfter) },
  });
}

/** The per-IP bucket key: an IPv6 address is bucketed by its /64, so rotating addresses inside one does not help. */
const ipBucket = (ip: string): string => RATE_BUCKET_PREFIX + normaliseIpForBucketing(ip);

/**
 * `HEAD`: the kill switch (the same generic 404 GET returns, so HEAD never reveals the endpoint), then ONLY the
 * per-IP limit, then 405. No token lookup, no database, no Blob, no row. Next would otherwise derive HEAD from
 * GET, so a link prefetcher's HEAD with a valid token would watermark a whole file and spend the grantee's
 * daily cap.
 */
export function handleDatasetHeadRequest(request: Request): Response {
  if (!isDatasetSharingEnabled()) return notFound();
  const rate = checkApiRateLimit(ipBucket(extractTrustedClientIp(request.headers)));
  if (!rate.ok) return rateLimited(rate.retryAfter);
  return new Response(null, { status: 405, headers: { ...BASE_HEADERS, Allow: "GET" } });
}

/** Generic 503 for everything that is the server's fault; names no cause. */
function unavailable(): Response {
  return new Response(JSON.stringify({ error: "Temporarily unavailable. Please try again later." }), {
    status: 503,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

/** `hashIp` throws in production when the salt is unset; a log row must not turn that into a failed download. */
function safeIpHash(ip: string): string | null {
  try {
    return hashIp(normaliseIpForBucketing(ip));
  } catch {
    return null;
  }
}

/** The single value of a query parameter, or null when absent or repeated (`f=a&f=b` is not "a"). */
function singleParam(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] : null;
}

/**
 * Best-effort outcome change on the reserved row for the failure paths (`denied_rate`, `error`): the response is
 * already decided, so a failed update is logged by SQLSTATE and swallowed. A null id (the reserve insert failed
 * and the request failed open) has nothing to update.
 */
async function settleDownload(rowId: string | null, outcome: DatasetDownloadOutcome): Promise<void> {
  if (rowId === null) return;
  try {
    await getDb().update(datasetDownloadsTable).set({ outcome }).where(eq(datasetDownloadsTable.id, rowId));
  } catch (err) {
    console.error(`dataset download: log write failed (sqlstate: ${redactedErrorCode(err)})`);
  }
}

/**
 * Vercel caps a function's NON-streamed response body at 4.5 MB ("The maximum payload size for the request body
 * or the response body of a Vercel Function is 4.5 MB. The response body limit doesn't apply to streamed
 * responses." - vercel.com/docs/functions/limitations, read 2026-11-09) and facilities.json is ~6.6-8.8 MB, so
 * EVERY file is returned as a stream. Pull-based, 64 KiB at a time; no Content-Length is set.
 */
function streamBody(text: string): ReadableStream<Uint8Array> {
  const bytes = Buffer.from(text, "utf8");
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + DATASET_STREAM_CHUNK_BYTES)));
      offset += DATASET_STREAM_CHUNK_BYTES;
    },
  });
}

export async function handleDatasetFileRequest(request: Request): Promise<Response> {
  if (!isDatasetSharingEnabled()) return notFound();

  const ip = extractTrustedClientIp(request.headers);
  const rate = checkApiRateLimit(ipBucket(ip));
  if (!rate.ok) return rateLimited(rate.retryAfter);

  const url = new URL(request.url);
  const file = singleParam(url, "f");
  if (file === null || !isAllowlistedFile(file)) return notFound();
  const token = singleParam(url, "t");
  if (token === null) return notFound();

  // Held here so a throw anywhere after the reserve can still settle the row it left `served`.
  const reserved: { rowId: string | null } = { rowId: null };
  try {
    return await serve(token, file, ip, reserved);
  } catch (err) {
    console.error(`dataset download failed (sqlstate: ${redactedErrorCode(err)})`);
    await settleDownload(reserved.rowId, "error");
    return unavailable();
  }
}

async function serve(
  token: string,
  file: DatasetEditionFileName,
  ip: string,
  reserved: { rowId: string | null }
): Promise<Response> {
  const resolved = await getGrantByAccessToken(token);
  if (resolved.state !== "active") return notFound();
  const grantId = resolved.grant.id;

  const edition = await latestPublishedEdition();
  if (!edition) return notFound();
  const ipHash = safeIpHash(ip);

  // Before the reserve: a deploy without a usable secret must not write a row per request.
  const secret = (process.env.DATASET_WATERMARK_SECRET ?? "").trim();
  const watermarked = file === "facilities.json" || file === "facilities.csv";
  if (watermarked && secret.length < MIN_WATERMARK_SECRET_LENGTH) {
    console.error("dataset download: watermark secret missing or too short"); // never serve the two record files unmarked
    return unavailable();
  }

  // Reserve a `served` row FIRST, then count the grant's `served` rows in the window including it. Counting
  // first and inserting after lets a burst of concurrent requests all read the same count and all pass. A burst
  // can therefore over-deny (every request sees the others' reservations) but never over-serve. Denied and failed
  // attempts become `denied_rate` / `error` rows, which the count ignores, so they never move the window.
  // Fail OPEN if the bookkeeping itself fails: a database hiccup must not deny a file the grantee is entitled to.
  // The cost is bounded: a failed reserve is one uncounted download.
  const db = getDb();
  try {
    const [row] = await db
      .insert(datasetDownloadsTable)
      .values({ grantId, editionId: edition.id, file, ipHash, outcome: "served" })
      .returning({ id: datasetDownloadsTable.id });
    reserved.rowId = row.id;
    const windowStart = new Date(Date.now() - DATASET_GRANT_WINDOW_MS);
    const [usage] = await db
      .select({ served: count(), oldest: min(datasetDownloadsTable.createdAt) })
      .from(datasetDownloadsTable)
      .where(
        and(
          eq(datasetDownloadsTable.grantId, grantId),
          eq(datasetDownloadsTable.outcome, "served"),
          gt(datasetDownloadsTable.createdAt, windowStart)
        )
      );
    if (usage.served > DATASET_GRANT_DAILY_LIMIT) {
      await settleDownload(reserved.rowId, "denied_rate");
      const oldest = usage.oldest ? new Date(usage.oldest).getTime() : Date.now();
      const retryAfter = Math.max(1, Math.ceil((oldest + DATASET_GRANT_WINDOW_MS - Date.now()) / 1000));
      return rateLimited(retryAfter);
    }
  } catch (err) {
    console.error(`dataset download: reserve failed (sqlstate: ${redactedErrorCode(err)})`);
  }

  const failed = async (): Promise<Response> => {
    await settleDownload(reserved.rowId, "error");
    return unavailable();
  };

  // The edition date goes into a Content-Disposition filename: validate the shape rather than trust the column.
  const record = edition.files.find((f) => f.name === file);
  if (!record || !EDITION_DATE_RE.test(edition.editionDate)) return failed();
  if (record.pathname !== `editions/${edition.editionDate}/${file}`) return failed();

  let text: string | null;
  try {
    text = await getEditionFileText(record.pathname);
  } catch (err) {
    console.error(`dataset download: blob read failed (code: ${err instanceof DatasetBlobError ? err.code : "unknown"})`);
    return failed();
  }
  if (text === null) return failed();

  // A reclaimed failed build can upload late over an edition's pathname: serve only bytes that are exactly what
  // was published (the hash and size recorded at publish time).
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength !== record.bytes || createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
    console.error(`dataset download: integrity mismatch (file: ${file})`);
    return failed();
  }

  let body = text;
  if (watermarked) {
    const key = { secret, grantId, editionId: edition.id };
    try {
      body = file === "facilities.json" ? watermarkJsonArray(text, key) : watermarkCsv(text, key);
    } catch (err) {
      console.error(`dataset download: watermark failed (code: ${err instanceof WatermarkError ? err.code : "unknown"})`);
      return failed();
    }
  }

  // Bump the counter only now that the body is ready to stream, whether or not a row could be reserved: a
  // failed-open reserve must not make the grantee's download_count undercount what was served.
  try {
    await db
      .update(datasetAccessGrantsTable)
      .set({ downloadCount: sql`${datasetAccessGrantsTable.downloadCount} + 1`, lastDownloadAt: new Date() })
      .where(eq(datasetAccessGrantsTable.id, grantId));
  } catch (err) {
    console.error(`dataset download: counter write failed (sqlstate: ${redactedErrorCode(err)})`);
  }

  return new Response(streamBody(body), {
    status: 200,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": CONTENT_TYPES[file],
      "Content-Disposition": `attachment; filename="compute-atlas-${edition.editionDate}-${file}"`,
    },
  });
}
