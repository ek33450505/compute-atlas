import { createHash } from "node:crypto";

import { BlobNotFoundError, del, get, list, put } from "@vercel/blob";

/**
 * The ONLY module that touches `@vercel/blob`. Dataset editions live in a
 * PRIVATE Blob store under `editions/<YYYY-MM-DD>/<allowlisted name>`; no
 * user input reaches the store except through `editionPathname`.
 *
 * SDK surface used, verified against the installed @vercel/blob 2.8.2 .d.ts:
 * - `put(pathname, body, { access: "private", addRandomSuffix: false,
 *   allowOverwrite: true })` — deterministic pathname; a reclaimed failed
 *   build re-uploads the same pathname, so overwrite must be allowed.
 *   Cached-read invariant: only `building`/`failed` editions are ever
 *   re-uploaded (reclaim); they are never served, and a `published` edition's
 *   files are never overwritten. That is what makes the SDK's default CDN
 *   cache on `get` safe. If that invariant ever changes, reads must pass
 *   `useCache: false`.
 * - `get(pathname, { access: "private" })` — resolves `null` on a 404,
 *   otherwise `{ statusCode: 200, stream, ... }` (no `ifNoneMatch` is sent, so
 *   a 304 is unexpected and treated as a failure). `BlobNotFoundError` is also
 *   mapped to null defensively.
 * - `list({ prefix, cursor })` — paginated via `hasMore`/`cursor`.
 * - `del(pathnames[])` — batch delete by pathname.
 * Auth is resolved by the SDK from env, never passed, read or logged here: either
 * `BLOB_READ_WRITE_TOKEN`, or OIDC (a Vercel-issued OIDC token plus the
 * `BLOB_STORE_ID` env, since no `storeId` option is passed).
 *
 * Errors surface as `DatasetBlobError` with a fixed `code` and NO SDK text
 * (it can carry store URLs and tokens). Nothing here logs; callers log `code`.
 */

export const DATASET_EDITION_FILES = [
  "facilities.json",
  "facilities.csv",
  "siting-context.json",
  "changelog.json",
  "README.txt",
] as const;

export type DatasetEditionFileName = (typeof DATASET_EDITION_FILES)[number];

export type DatasetBlobErrorCode =
  | "blob_invalid_path"
  | "blob_put_failed"
  | "blob_get_failed"
  | "blob_delete_failed"
  | "blob_list_failed";

export class DatasetBlobError extends Error {
  readonly code: DatasetBlobErrorCode;

  constructor(code: DatasetBlobErrorCode) {
    super(code);
    this.name = "DatasetBlobError";
    this.code = code;
  }
}

const EDITION_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EDITION_PATH_RE = /^editions\/(\d{4}-\d{2}-\d{2})\/([^/]+)$/;

function isEditionFileName(name: string): name is DatasetEditionFileName {
  return (DATASET_EDITION_FILES as readonly string[]).includes(name);
}

function isRealCalendarDate(date: string): boolean {
  if (!EDITION_DATE_RE.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return (
    parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d
  );
}

function assertEditionDate(date: string): void {
  if (!isRealCalendarDate(date)) throw new DatasetBlobError("blob_invalid_path");
}

/** `editions/<date>/<name>`; throws unless the date is real and the name is allowlisted (exact match). */
export function editionPathname(editionDate: string, name: string): string {
  assertEditionDate(editionDate);
  if (!isEditionFileName(name)) throw new DatasetBlobError("blob_invalid_path");
  return `editions/${editionDate}/${name}`;
}

/** Re-derive the pathname from its parts; rejects anything that is not exactly a canonical edition path. */
function assertEditionPathname(pathname: string): void {
  const match = EDITION_PATH_RE.exec(pathname);
  if (!match || editionPathname(match[1], match[2]) !== pathname) {
    throw new DatasetBlobError("blob_invalid_path");
  }
}

export async function putEditionFile(
  editionDate: string,
  name: string,
  body: string,
): Promise<{ pathname: string; bytes: number; sha256: string }> {
  const pathname = editionPathname(editionDate, name);
  const buffer = Buffer.from(body, "utf8");
  try {
    await put(pathname, buffer, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch {
    throw new DatasetBlobError("blob_put_failed");
  }
  return {
    pathname,
    bytes: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

/**
 * Returns the raw fetch body stream (null when absent). A caller that abandons
 * the stream without reading it to the end must `cancel()` it.
 */
export async function getEditionFile(
  pathname: string,
): Promise<ReadableStream<Uint8Array> | null> {
  assertEditionPathname(pathname);
  let result: Awaited<ReturnType<typeof get>>;
  try {
    // Default CDN cache is deliberate: see the cached-read invariant in the file header.
    result = await get(pathname, { access: "private" });
  } catch (err) {
    if (err instanceof BlobNotFoundError) return null;
    throw new DatasetBlobError("blob_get_failed");
  }
  if (result === null) return null;
  if (result.statusCode !== 200) throw new DatasetBlobError("blob_get_failed");
  return result.stream;
}

/** Buffers a file to a string (used for watermarking); null when the file is absent. */
export async function getEditionFileText(pathname: string): Promise<string | null> {
  const stream = await getEditionFile(pathname);
  if (stream === null) return null;
  try {
    return await new Response(stream).text();
  } catch {
    throw new DatasetBlobError("blob_get_failed");
  }
}

/** Deletes every blob under `editions/<date>/`; returns how many were deleted. */
export async function deleteEditionPrefix(editionDate: string): Promise<number> {
  assertEditionDate(editionDate);
  const prefix = `editions/${editionDate}/`;

  const pathnames: string[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = await list({ prefix, cursor });
      for (const blob of page.blobs) {
        if (blob.pathname.startsWith(prefix)) pathnames.push(blob.pathname);
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor !== undefined);
  } catch {
    throw new DatasetBlobError("blob_list_failed");
  }

  if (pathnames.length === 0) return 0;
  try {
    await del(pathnames);
  } catch {
    throw new DatasetBlobError("blob_delete_failed");
  }
  return pathnames.length;
}
