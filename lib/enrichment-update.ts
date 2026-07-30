import { z } from "zod";
import {
  sourceSchema,
  capacityMwSchema,
  energySchema,
  waterSchema,
  communityStatusEnum,
  aiClassificationEnum,
} from "@/lib/schema";
import type { Facility } from "@/lib/schema";

/**
 * Append-only enrichment core.
 *
 * Mirrors `lib/status-update.ts`'s append-only invariant: any retained field
 * carrying a `sourceIndex` (statusHistory, community, subsidies[], jobs)
 * would point out of range if `sources` were reordered or shortened, and
 * `facilitySchema`'s `checkSourceIndexBounds` superRefine rejects the write.
 * Enrichment upholds the same invariant — it never rewrites or reorders
 * `existing.sources`, only appends.
 *
 * Enrichment differs from a status update in two ways:
 *  1. It is FILL-MISSING, not overwrite. Enrichment corroborates facts the
 *     curated record doesn't have yet; it never contests a curated value.
 *     Every scalar/object field is only set when the existing value is
 *     currently `undefined`.
 *  2. The intent an LLM produces carries source indices RELATIVE to its own
 *     (small) `sources[]` array — `sourceRel` — because the model never sees
 *     the full facility. `applyEnrichmentUpdate` remaps `sourceRel` to an
 *     absolute `sourceIndex` by adding `existing.sources.length` (captured
 *     BEFORE the append), the same offset trick `applyStatusUpdate` uses.
 */

// ---------------------------------------------------------------------------
// Intent schema — compact projection. `.strict()` at every object level is
// the overwrite guard: it rejects curated fields (status, operator, lat/lon,
// id, ...) the model has no business touching. Do not loosen.
// ---------------------------------------------------------------------------

export const enrichmentUpdateIntentSchema = z
  .object({
    date: z.string().min(4),
    sources: z.array(sourceSchema).min(1).max(20),
    fields: z
      .object({
        capacityMw: capacityMwSchema.strict().optional(),
        energy: energySchema.strict().optional(),
        water: waterSchema.strict().optional(),
        location: z
          .object({
            street: z.string().min(1).optional(),
            postalCode: z.string().min(1).optional(),
          })
          .strict()
          .optional(),
        investmentUsd: z.number().positive().optional(),
        landAcres: z.number().positive().optional(),
        aiClassification: aiClassificationEnum.optional(),
        jobs: z
          .object({
            construction: z.number().int().nonnegative().optional(),
            permanent: z.number().int().nonnegative().optional(),
            sourceRel: z.number().int().nonnegative(),
          })
          .strict()
          .optional(),
        community: z
          .object({
            status: communityStatusEnum.optional(),
            notes: z.string().optional(),
            sourceRel: z.number().int().nonnegative(),
          })
          .strict()
          .optional(),
        subsidies: z
          .array(
            z
              .object({
                program: z.string().optional(),
                amountUsd: z.number().nonnegative().optional(),
                jurisdiction: z.string().optional(),
                year: z
                  .string()
                  .regex(/^\d{4}(\/\d{4})*$/, "year must be a 4-digit year, or slash-separated 4-digit years (e.g. 2013/2015)")
                  .optional(),
                sourceRel: z.number().int().nonnegative(),
              })
              .strict()
          )
          .max(20)
          .optional(),
      })
      .strict(),
    reSourced: z
      .array(
        z
          .object({
            replacesUrl: z.string().url(),
            sourceRel: z.number().int().nonnegative(),
          })
          .strict()
      )
      .max(20)
      .optional(),
  })
  .strict()
  .superRefine((intent, ctx) => {
    const n = intent.sources.length;
    const check = (rel: number | undefined, path: (string | number)[]) => {
      if (rel !== undefined && rel >= n) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `sourceRel ${rel} out of range (intent has ${n} source(s))`,
        });
      }
    };
    check(intent.fields.jobs?.sourceRel, ["fields", "jobs", "sourceRel"]);
    check(intent.fields.community?.sourceRel, ["fields", "community", "sourceRel"]);
    intent.fields.subsidies?.forEach((s, i) =>
      check(s.sourceRel, ["fields", "subsidies", i, "sourceRel"])
    );
    intent.reSourced?.forEach((r, i) => check(r.sourceRel, ["reSourced", i, "sourceRel"]));
  });

export type EnrichmentUpdateIntent = z.infer<typeof enrichmentUpdateIntentSchema>;

// ---------------------------------------------------------------------------
// Missing-family detection — single source of truth for "what can we still
// enrich on this facility." Reused by the discovery enrichment prompt
// builder (Unit 6) so eligibility logic lives in exactly one place.
// ---------------------------------------------------------------------------

export const ENRICHABLE_FAMILIES = [
  "capacityMw",
  "energy",
  "water",
  "address",
  "investmentUsd",
  "landAcres",
  "aiClassification",
  "jobs",
  "community",
  "subsidies",
] as const;

export type EnrichableFamily = (typeof ENRICHABLE_FAMILIES)[number];

export function missingEnrichableFamilies(facility: Facility): EnrichableFamily[] {
  const missing: EnrichableFamily[] = [];

  if (facility.capacityMw?.planned === undefined || facility.capacityMw?.operational === undefined) {
    missing.push("capacityMw");
  }
  if (
    facility.energy === undefined ||
    facility.energy.source === undefined ||
    facility.energy.utility === undefined ||
    facility.energy.onSiteGenerationMw === undefined
  ) {
    missing.push("energy");
  }
  if (
    facility.water === undefined ||
    facility.water.coolingType === undefined ||
    facility.water.reportedMgd === undefined
  ) {
    missing.push("water");
  }
  if (facility.location.street === undefined || facility.location.postalCode === undefined) {
    missing.push("address");
  }
  if (facility.investmentUsd === undefined) {
    missing.push("investmentUsd");
  }
  if (facility.landAcres === undefined) {
    missing.push("landAcres");
  }
  if (
    facility.facilityType !== "power_generation" &&
    facility.aiClassification === undefined
  ) {
    missing.push("aiClassification");
  }
  if (facility.jobs === undefined) {
    missing.push("jobs");
  }
  if (facility.community === undefined) {
    missing.push("community");
  }
  if (facility.subsidies === undefined || facility.subsidies.length === 0) {
    missing.push("subsidies");
  }

  return missing;
}

// ---------------------------------------------------------------------------
// applyEnrichmentUpdate — pure, does not mutate `existing`, does not throw.
// Callers validate the result against `facilitySchema` if they need a hard
// guarantee (the same contract as `applyStatusUpdate`).
// ---------------------------------------------------------------------------

export function applyEnrichmentUpdate(
  existing: Facility,
  intent: EnrichmentUpdateIntent
): Facility {
  const appendBase = existing.sources.length;
  const sources = [...existing.sources, ...intent.sources];
  const fields = intent.fields;

  const overrides: Record<string, unknown> = {
    lastUpdated: intent.date,
    sources,
  };

  // 1. capacityMw — sub-field fill-missing.
  if (fields.capacityMw) {
    const next: { planned?: number; operational?: number } = { ...(existing.capacityMw ?? {}) };
    if (existing.capacityMw?.planned === undefined && fields.capacityMw.planned !== undefined) {
      next.planned = fields.capacityMw.planned;
    }
    if (
      existing.capacityMw?.operational === undefined &&
      fields.capacityMw.operational !== undefined
    ) {
      next.operational = fields.capacityMw.operational;
    }
    if (Object.keys(next).length > 0) overrides.capacityMw = next;
  }

  // 2. energy — sub-field fill-missing.
  if (fields.energy) {
    const next: {
      source?: typeof fields.energy.source;
      utility?: string;
      onSiteGenerationMw?: number;
      notes?: string;
    } = { ...(existing.energy ?? {}) };
    if (existing.energy?.source === undefined && fields.energy.source !== undefined) {
      next.source = fields.energy.source;
    }
    if (existing.energy?.utility === undefined && fields.energy.utility !== undefined) {
      next.utility = fields.energy.utility;
    }
    if (
      existing.energy?.onSiteGenerationMw === undefined &&
      fields.energy.onSiteGenerationMw !== undefined
    ) {
      next.onSiteGenerationMw = fields.energy.onSiteGenerationMw;
    }
    if (existing.energy?.notes === undefined && fields.energy.notes !== undefined) {
      next.notes = fields.energy.notes;
    }
    if (Object.keys(next).length > 0) overrides.energy = next;
  }

  // 3. water — sub-field fill-missing.
  if (fields.water) {
    const next: {
      coolingType?: typeof fields.water.coolingType;
      reportedMgd?: number;
      notes?: string;
    } = { ...(existing.water ?? {}) };
    if (existing.water?.coolingType === undefined && fields.water.coolingType !== undefined) {
      next.coolingType = fields.water.coolingType;
    }
    if (existing.water?.reportedMgd === undefined && fields.water.reportedMgd !== undefined) {
      next.reportedMgd = fields.water.reportedMgd;
    }
    if (existing.water?.notes === undefined && fields.water.notes !== undefined) {
      next.notes = fields.water.notes;
    }
    if (Object.keys(next).length > 0) overrides.water = next;
  }

  // 4. location — always spread existing; fill street/postalCode only if
  // the existing sub-field is undefined.
  if (fields.location) {
    const nextStreet =
      existing.location.street === undefined && fields.location.street !== undefined
        ? fields.location.street
        : existing.location.street;
    const nextPostalCode =
      existing.location.postalCode === undefined && fields.location.postalCode !== undefined
        ? fields.location.postalCode
        : existing.location.postalCode;
    if (nextStreet !== existing.location.street || nextPostalCode !== existing.location.postalCode) {
      overrides.location = {
        ...existing.location,
        ...(nextStreet !== undefined ? { street: nextStreet } : {}),
        ...(nextPostalCode !== undefined ? { postalCode: nextPostalCode } : {}),
      };
    }
  }

  // 5. investmentUsd / landAcres — scalar fill-missing.
  if (fields.investmentUsd !== undefined && existing.investmentUsd === undefined) {
    overrides.investmentUsd = fields.investmentUsd;
  }
  if (fields.landAcres !== undefined && existing.landAcres === undefined) {
    overrides.landAcres = fields.landAcres;
  }

  // 6. aiClassification — only when undefined AND the branch carries it.
  // power_generation has no aiClassification field; drop it there.
  if (
    fields.aiClassification !== undefined &&
    existing.facilityType !== "power_generation" &&
    existing.aiClassification === undefined
  ) {
    overrides.aiClassification = fields.aiClassification;
  }

  // 7. jobs — sourceIndex SINGLETON: fill only when the whole object is
  // absent; remap the intent-relative index to an absolute one.
  if (fields.jobs && existing.jobs === undefined) {
    overrides.jobs = {
      ...(fields.jobs.construction !== undefined ? { construction: fields.jobs.construction } : {}),
      ...(fields.jobs.permanent !== undefined ? { permanent: fields.jobs.permanent } : {}),
      sourceIndex: appendBase + fields.jobs.sourceRel,
    };
  }

  // 8. community — sourceIndex SINGLETON: fill only when the whole object
  // is absent.
  if (fields.community && existing.community === undefined) {
    overrides.community = {
      ...(fields.community.status !== undefined ? { status: fields.community.status } : {}),
      ...(fields.community.notes !== undefined ? { notes: fields.community.notes } : {}),
      sourceIndex: appendBase + fields.community.sourceRel,
    };
  }

  // 9. subsidies — APPEND-with-dedup. Existing entries keep their
  // sourceIndex untouched; the array only grows.
  if (fields.subsidies && fields.subsidies.length > 0) {
    const key = (s: { program?: string; year?: string; jurisdiction?: string }) =>
      `${(s.program ?? "").trim().toLowerCase()}|${s.year ?? ""}|${(s.jurisdiction ?? "").trim().toLowerCase()}`;
    const existingKeys = new Set((existing.subsidies ?? []).map(key));
    const toAppend = fields.subsidies
      .filter((s) => !existingKeys.has(key(s)))
      .map((s) => ({
        ...(s.program !== undefined ? { program: s.program } : {}),
        ...(s.amountUsd !== undefined ? { amountUsd: s.amountUsd } : {}),
        ...(s.jurisdiction !== undefined ? { jurisdiction: s.jurisdiction } : {}),
        ...(s.year !== undefined ? { year: s.year } : {}),
        sourceIndex: appendBase + s.sourceRel,
      }));
    if (toAppend.length > 0) {
      overrides.subsidies = [...(existing.subsidies ?? []), ...toAppend];
    }
  }

  // 10. reSourced is provenance-only — its replacement sources are already
  // appended to `sources` above (step 0). There is no field to merge; a
  // `replacesUrl` that doesn't match an existing source is silently ignored
  // rather than thrown, consistent with this function's no-throw contract.

  // Facility is a discriminatedUnion on facilityType. A spread of
  // `{...existing, ...overrides}` only touches shared base fields, but tsc
  // can lose the branch's literal `facilityType` narrowing across a plain
  // object spread of a union type. Switch on facilityType so each branch's
  // return type is inferred directly from that branch's object literal
  // rather than the union as a whole — mirrors `applyStatusUpdate`.
  switch (existing.facilityType) {
    case "data_center":
      return { ...existing, ...overrides };
    case "crypto_mining":
      return { ...existing, ...overrides };
    case "power_generation":
      return { ...existing, ...overrides };
  }
}
