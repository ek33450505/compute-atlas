import { unauthorized } from "@/lib/api-auth";
import { jsonResponse } from "@/lib/api-response";
import { hasValidCronSecret } from "@/lib/cron-auth";
import { buildEdition } from "@/lib/dataset-edition-builder";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";

export const dynamic = "force-dynamic";
// The build reads the whole dataset, zips it and uploads; give it the Pro-plan ceiling.
export const maxDuration = 300;

/**
 * Weekly dataset-edition build, fired by Vercel Cron (`vercel.json`, Saturdays 14:00 UTC).
 *
 * Cron secret ONLY: there is no admin-bearer fallback here, unlike the state-digest route.
 * The admin "Build now" action is a server action, not a call to this route.
 *
 * Every response is `no-store` via `jsonResponse`. This is a GET under `/api/`, and the
 * Cloudflare cache rule makes every non-`/admin` GET edge-cacheable otherwise.
 * `proxy.ts` exempts `/api/cron/*` from the edge-secret gate (`isCronPath`), so Vercel Cron
 * reaches it without traversing Cloudflare.
 *
 * Bodies are a fixed shape: the builder returns a fixed `code` for a failure and this route
 * never relays an error message or stack (they can embed bound params or store URLs).
 */
export async function GET(request: Request): Promise<Response> {
  // 1. AUTH FIRST, fail closed.
  if (!hasValidCronSecret(request)) {
    return unauthorized();
  }

  // 2. KILL SWITCH, strictly AFTER auth, so an unauthenticated caller cannot probe the flag.
  //    No DB access and no build while off.
  if (!isDatasetSharingEnabled()) {
    return jsonResponse({ ok: true, skipped: "disabled" });
  }

  // 3. The builder never throws; a `failed` outcome becomes a 500 so Vercel Cron marks the
  //    run failed. Fields are picked explicitly rather than spread.
  const result = await buildEdition({ ignoreRetryCooldown: true });
  if (result.outcome === "failed") {
    // The builder's own line carries the step and code but not the date.
    console.error(`dataset edition cron: failed ${result.editionDate} (code: ${result.code})`);
    return jsonResponse(
      {
        ok: false,
        outcome: result.outcome,
        ...(result.editionId !== undefined && { editionId: result.editionId }),
        editionDate: result.editionDate,
        code: result.code,
      },
      { status: 500 }
    );
  }
  if (result.outcome !== "published") {
    console.info(`dataset edition cron: ${result.outcome} ${result.editionDate}`);
  }
  return jsonResponse({
    ok: true,
    outcome: result.outcome,
    editionId: result.editionId,
    editionDate: result.editionDate,
    ...(result.outcome === "published" && { recordCount: result.recordCount }),
  });
}
