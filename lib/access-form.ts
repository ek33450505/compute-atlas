import { NextResponse } from "next/server";

import { NO_STORE_HEADERS } from "@/lib/api-response";
import { DATASET_TOKEN_RE } from "@/lib/dataset-grants";
import { readBodyText } from "@/lib/read-json-body";

/** A form post carries one 43-char token; 4 KiB is generous. */
const MAX_BODY_BYTES = 4096;

/** The token from a urlencoded form body, or null if the body is oversize, unreadable, or the token missing or malformed. */
export async function readFormToken(request: Request): Promise<string | null> {
  const read = await readBodyText(request, { maxBytes: MAX_BODY_BYTES });
  if (!read.ok) return null;
  const token = new URLSearchParams(read.text).get("token");
  return token && DATASET_TOKEN_RE.test(token) ? token : null;
}

/**
 * Same-origin 303 to a hardcoded page, no-store. The literal union keeps every target fixed, so the
 * redirect can never be derived from input (no open-redirect surface).
 */
export function formRedirect(
  request: Request,
  path: "/access/confirmed" | "/access/renewed" | "/access/invalid"
): NextResponse {
  return NextResponse.redirect(new URL(path, request.url), { status: 303, headers: NO_STORE_HEADERS });
}
