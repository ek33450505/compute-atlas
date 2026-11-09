import { handleDatasetFileRequest, handleDatasetHeadRequest } from "@/lib/dataset-download";

// Per-request: the response depends on the token and writes a log row, so it must never be prerendered or cached.
export const dynamic = "force-dynamic";

/**
 * An approved grantee's file download (`?t=<access token>&f=<file name>`). All behaviour, and the order of its
 * gates, lives in `lib/dataset-download.ts`. GET and an explicit HEAD: without the export Next derives HEAD from
 * GET, so a prefetcher's HEAD would run the whole download. No `OPTIONS`: the link is followed by navigation, never fetched cross-origin by script.
 */
export async function GET(request: Request) {
  return handleDatasetFileRequest(request);
}

/** Answers 405 after the per-IP limit alone: no token lookup, no Blob, no row. */
export function HEAD(request: Request) {
  return handleDatasetHeadRequest(request);
}
