import { revalidateTag } from "next/cache";

import { jsonResponse, corsPreflight } from "@/lib/api-response";
import { requireAdmin } from "@/lib/api-auth";
import { isValidCacheTag, MAX_TAGS_PER_REQUEST } from "@/lib/cache-tags";

/**
 * Admin-only on-demand cache-revalidation route. Direct Neon writes (bulk
 * data waves via scripts, not the app) can't bust Next's scoped
 * `unstable_cache` tags themselves — only the running app can — so a bulk
 * upsert step calls this route afterward with the tags it touched, e.g.
 * `{ tags: ["state:CA", "operator:some-operator-slug"] }`. `"facilities"` is
 * still a valid tag (see `tagsForChanges` in `scripts/sync-to-neon.ts`) but
 * no longer reaches the ⌘K nav index — `loadFacilitiesForSearch` is
 * deliberately untagged (see `lib/search-index.ts`) and refreshes only on
 * its own 86400s timer, so busting `"facilities"` alone will not update it.
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
  if (tags.length > MAX_TAGS_PER_REQUEST) {
    return jsonResponse({ error: `Too many tags (max ${MAX_TAGS_PER_REQUEST})` }, { status: 400 });
  }

  for (const tag of tags) {
    if (typeof tag !== "string" || !isValidCacheTag(tag)) {
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
