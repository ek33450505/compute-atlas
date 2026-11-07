import { revalidateTag } from "next/cache";

import { isValidCacheTag, MAX_TAGS_PER_REQUEST } from "@/lib/cache-tags";

export type BustTagsResult =
  | { ok: true; tags: string[] }
  | { ok: false; error: string };

/**
 * Validate every tag against the cache-tag vocabulary, THEN bust them all with
 * the stale-while-revalidate "max" profile. Nothing is busted unless every tag
 * passes, so a typo can't half-apply. Shared by `POST /api/revalidate` and the
 * admin "Refresh site" action so the two can't drift apart.
 */
export function bustCacheTags(tags: readonly unknown[]): BustTagsResult {
  if (tags.length > MAX_TAGS_PER_REQUEST) {
    return { ok: false, error: `Too many tags (max ${MAX_TAGS_PER_REQUEST})` };
  }

  for (const tag of tags) {
    if (typeof tag !== "string" || !isValidCacheTag(tag)) {
      return { ok: false, error: `Invalid tag: ${String(tag)}` };
    }
  }

  const validTags = tags as string[];
  for (const tag of validTags) {
    revalidateTag(tag, "max");
  }
  return { ok: true, tags: validTags };
}
