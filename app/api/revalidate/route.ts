import { revalidateTag } from "next/cache";

import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { requireAdmin } from "@/lib/api-auth";

/**
 * Cache-tag shapes actually produced by `unstable_cache` callers in
 * `lib/data.ts` (`"facilities"`, `` `facility:${id}` ``, `` `state:${STATE}` ``,
 * `"power-generation"`) and busted by `revalidateForFacility` in
 * `lib/facility-write.ts`. Anything outside this allowlist is rejected rather
 * than silently dropped, so a typo'd tag surfaces immediately instead of
 * quietly no-op'ing.
 */
const LITERAL_TAGS = new Set(["facilities", "power-generation"]);
const TAG_PATTERNS = [/^state:[A-Z]{2}$/, /^facility:[a-z0-9-]+$/];

/** Hard cap on tags per request — bounds the synchronous revalidateTag() loop below. */
const MAX_TAGS = 100;

function isValidTag(tag: string): boolean {
  return LITERAL_TAGS.has(tag) || TAG_PATTERNS.some((pattern) => pattern.test(tag));
}

/**
 * Admin-only on-demand cache-revalidation route. Direct Neon writes (bulk
 * data waves via scripts, not the app) can't bust Next's scoped
 * `unstable_cache` tags themselves — only the running app can — so a bulk
 * upsert step calls this route afterward with the tags it touched, e.g.
 * `{ tags: ["facilities", "state:CA"] }`.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = requireAdmin(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, { status: 400 });
  }

  const tags = (body as { tags?: unknown } | null)?.tags;
  if (!Array.isArray(tags) || tags.length === 0) {
    return jsonResponse({ error: "tags must be a non-empty array" }, { status: 400 });
  }
  if (tags.length > MAX_TAGS) {
    return jsonResponse({ error: `Too many tags (max ${MAX_TAGS})` }, { status: 400 });
  }

  for (const tag of tags) {
    if (typeof tag !== "string" || !isValidTag(tag)) {
      return jsonResponse({ error: `Invalid tag: ${String(tag)}` }, { status: 400 });
    }
  }

  const validTags = tags as string[];
  for (const tag of validTags) {
    revalidateTag(tag, "max");
  }

  return jsonResponse({ revalidated: validTags });
}

export function OPTIONS(): Response {
  return corsPreflight();
}
