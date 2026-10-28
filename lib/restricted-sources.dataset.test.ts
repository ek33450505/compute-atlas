import { describe, it, expect } from "vitest";
import facilitiesRaw from "@/data/facilities.json";

import {
  RESTRICTED_SOURCE_DOMAINS,
  isRestrictedSourceUrl,
} from "./restricted-sources";

interface FacilityWithSources {
  id: string;
  sources: Array<{ url: string }>;
}

interface ProseHit {
  path: string;
  context: string;
}

/**
 * Matches a restricted domain as a whole token anywhere inside free text:
 * `interconnection.fyi`, `www.interconnection.fyi`, and
 * `interconnection.fyi/queue/...` all match; `notinterconnection.fyi` and
 * `interconnection.fyindex` do not. Built from RESTRICTED_SOURCE_DOMAINS so the
 * list cannot drift from the URL guard.
 */
const RESTRICTED_PROSE_PATTERN = new RegExp(
  "(?<![\\w.-])(?:[\\w-]+\\.)*(?:" +
    RESTRICTED_SOURCE_DOMAINS.map(({ domain }) =>
      domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ).join("|") +
    ")(?![\\w-])",
  "i",
);

/**
 * Walks every string value in `node` (any depth, arrays included) and returns
 * the ones that name a restricted domain. `sources[i].url` is skipped: the
 * URL test above owns that field, and keeping the two apart keeps each failure
 * message accurate.
 */
function collectRestrictedProse(
  node: unknown,
  path: string,
  hits: ProseHit[] = [],
): ProseHit[] {
  if (typeof node === "string") {
    const match = RESTRICTED_PROSE_PATTERN.exec(node);
    if (match) {
      const start = Math.max(0, match.index - 30);
      const end = Math.min(node.length, match.index + match[0].length + 30);
      hits.push({ path, context: `…${node.slice(start, end)}…` });
    }
    return hits;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) =>
      collectRestrictedProse(item, `${path}[${index}]`, hits),
    );
    return hits;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (/^sources\[\d+\]\.url$/.test(childPath)) continue;
      collectRestrictedProse(value, childPath, hits);
    }
  }
  return hits;
}

/**
 * Dataset-level regression tests, sibling to `lib/siting-context.test.ts`'s
 * "data-integrity" pattern: assert invariants over `data/facilities.json`
 * itself, not just over the guard function. `lib/restricted-sources.ts` and
 * `scripts/discovery/verify-source.ts` stop NEW restricted citations from
 * being ingested going forward; these tests catch an EXISTING one that
 * slipped in before the guard existed (or slipped past it some other way —
 * e.g. a maintainer-curated `db:sync` publish, which never calls
 * `verifySource` at all).
 *
 * Status as of 2026-10-28: the `sources[].url` test passes (no source URL
 * cites a restricted domain). ⚠️ The prose test is EXPECTED TO FAIL on the
 * current `data/facilities.json`: `iren-sweetwater-tx` names interconnection.fyi
 * in `notes` and `energy.notes`. The fix is a data change (research wave
 * 2026-10-28) landing in the same PR, not a weaker test. Do not weaken,
 * skip, or hand-edit the data here to make it pass.
 */
describe("data-integrity: no restricted-domain source URLs in the dataset", () => {
  it("has no facility whose sources[] cites a restricted domain", () => {
    const facilities = facilitiesRaw as FacilityWithSources[];

    const offenses = facilities.flatMap((facility) =>
      (facility.sources ?? [])
        .filter((source) => isRestrictedSourceUrl(source.url))
        .map((source) => `${facility.id}: ${source.url}`),
    );

    if (offenses.length > 0) {
      const shown = offenses.slice(0, 20);
      const more = offenses.length - shown.length;
      const suffix = more > 0 ? `, and ${more} more` : "";
      throw new Error(
        `${offenses.length} source URL(s) in data/facilities.json cite a ` +
          `licence-restricted domain (see lib/restricted-sources.ts): ` +
          `${shown.join("; ")}${suffix}. ` +
          "Restricted-domain terms forbid redistribution, and our own output " +
          "is CC-BY-4.0 — these facts must be re-sourced to a directly " +
          "citable origin (e.g. the ISO/RTO's own published interconnection " +
          "queue) rather than the aggregator, then republished via " +
          "`npm run db:sync -- --apply` and `npm run db:export`.",
      );
    }

    expect(offenses).toEqual([]);
  });

  it("has no facility whose prose attributes a fact to a restricted domain", () => {
    const facilities = facilitiesRaw as FacilityWithSources[];

    const offenses = facilities.flatMap((facility) =>
      collectRestrictedProse(facility, "").map(
        (hit) => `${facility.id} ${hit.path}: ${hit.context}`,
      ),
    );

    if (offenses.length > 0) {
      const shown = offenses.slice(0, 20);
      const more = offenses.length - shown.length;
      const suffix = more > 0 ? `, and ${more} more` : "";
      throw new Error(
        `${offenses.length} string value(s) in data/facilities.json name a ` +
          `licence-restricted domain in prose (see lib/restricted-sources.ts): ` +
          `${shown.join("; ")}${suffix}. ` +
          "The domain naming itself is not the problem — attributing a " +
          "republished fact to it is. That fact must be re-sourced to a " +
          "directly citable origin (e.g. the ISO/RTO's own published " +
          "interconnection queue), then republished via " +
          "`npm run db:sync -- --apply` and `npm run db:export`.",
      );
    }

    expect(offenses).toEqual([]);
  });

  it("flags a restricted domain in a nested prose field", () => {
    const hits = collectRestrictedProse(
      {
        id: "fixture-nested",
        energy: { notes: "Renewable supply via RECs, per interconnection.fyi." },
      },
      "",
    );

    expect(hits.map((hit) => hit.path)).toEqual(["energy.notes"]);
  });

  it("flags a restricted domain inside an array element", () => {
    const hits = collectRestrictedProse(
      {
        id: "fixture-array",
        notes: ["Checked the county filing.", "See www.interconnection.fyi/queue/123"],
      },
      "",
    );

    expect(hits.map((hit) => hit.path)).toEqual(["notes[1]"]);
  });

  it("does not flag sources[].url, which the URL test owns", () => {
    const hits = collectRestrictedProse(
      {
        id: "fixture-url",
        sources: [{ url: "https://interconnection.fyi/queue", title: "Queue" }],
      },
      "",
    );

    expect(hits).toEqual([]);
  });

  it("does not flag a lookalike host that merely contains the domain", () => {
    const hits = collectRestrictedProse(
      {
        id: "fixture-lookalike",
        notes: "Compare notinterconnection.fyi and interconnection.fyindex.",
      },
      "",
    );

    expect(hits).toEqual([]);
  });
});
