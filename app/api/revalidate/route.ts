import { jsonResponse, corsPreflight, methodNotAllowed } from "@/lib/api-response";
import { requireAdmin } from "@/lib/api-auth";
import { bustCacheTags } from "@/lib/revalidate-tags";

/**
 * Admin-only on-demand cache-revalidation route. Direct Neon writes (bulk
 * data waves via scripts, not the app) can't bust Next's scoped
 * `unstable_cache` tags themselves — only the running app can — so a bulk
 * upsert step calls this route afterward with the tags it touched, e.g.
 * `{ tags: ["state:CA", "operator:some-operator-slug"] }`. `"facilities"` is
 * still a valid tag (see `tagsForChanges` in `scripts/sync-to-neon.ts`; aggregate and hub pages
 * sit on a 24h timer, so bust it after a bulk write) but
 * no longer reaches the ⌘K nav index — `loadNavFacets` is
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

  const result = bustCacheTags(tags);
  if (!result.ok) {
    return jsonResponse({ error: result.error }, { status: 400 });
  }

  return jsonResponse({ revalidated: result.tags });
}

// `admin`: the only handler here is a bearer-gated POST, so `Authorization`
// genuinely has to be advertised.
export function OPTIONS(): Response {
  return corsPreflight("admin");
}

// POST-only: answer GET with a no-store 405 (a bare framework 405 is edge-cacheable).
export function GET() {
  return methodNotAllowed(["POST", "OPTIONS"]);
}
