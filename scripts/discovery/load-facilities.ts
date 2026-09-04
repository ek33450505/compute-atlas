/**
 * Loads the live facility set — read API first, JSON file fallback.
 *
 * This was byte-identical duplicated logic across five discovery scripts
 * (submit-candidates.ts, check-sources.ts, existing-facilities.ts,
 * extract-fields.ts, verify-fields.ts). The duplication existed because none
 * of those scripts may import one another — each is an independent CLI
 * entrypoint, and importing across them would create coupling between
 * otherwise-unrelated tools. This module resolves that without violating the
 * constraint: it is a leaf with no dependency on any other
 * scripts/discovery/*.ts file, so every script can import it without
 * creating a script-to-script edge. Do NOT import another
 * scripts/discovery/*.ts file from here — that would reintroduce exactly the
 * coupling this module exists to avoid.
 *
 * `fetchImpl` is optional and defaults to the global `fetch`, matching the
 * DI pattern in fetch-page-text.ts's `FetchPageTextDeps.fetchImpl` — added
 * solely so load-facilities.test.ts can inject a fake without touching real
 * network or the real data/facilities.json. Every existing call site omits
 * it and gets identical behavior to before this param existed.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Facility } from "../../lib/schema";

export async function loadFacilities(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<Facility[]> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/facilities`);
    if (res.ok) {
      const body = (await res.json()) as { facilities: Facility[] };
      return body.facilities;
    }
  } catch {
    // fall through to file fallback
  }

  const jsonPath = path.join(process.cwd(), "data", "facilities.json");
  const raw = readFileSync(jsonPath, "utf-8");
  return JSON.parse(raw) as Facility[];
}
