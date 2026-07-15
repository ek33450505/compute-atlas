import { z } from "zod";

import { createSubmission } from "@/lib/submissions";
import { facilitySchema, type Facility } from "@/lib/schema";
import { getFacilityById } from "@/lib/data";
import {
  CORRECTABLE_KEYS,
  CORRECTABLE_FIELD_META,
  type CorrectableKey,
} from "@/lib/contribute-fields";

export { CORRECTABLE_KEYS } from "@/lib/contribute-fields";

// Mirrors lib/schema.ts sourceSchema's http/https refine — rejects
// javascript:/data: URLs at submit time, not just at facility-write time.
const httpUrlSchema = z.string().max(2000).url().refine(
  (value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "url must use the http or https protocol" }
);

const createSchema = z.object({
  kind: z.literal("create"),
  website: z.string().max(200).optional(),
  name: z.string().min(1).max(200),
  operator: z.string().min(1).max(200),
  state: z.string().length(2),
  facilityType: z
    .enum(["data_center", "crypto_mining", "power_generation"])
    .default("data_center"),
  status: z
    .enum(["operational", "under_construction", "permitted", "proposed", "cancelled"])
    .default("proposed"),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  city: z.string().max(200).optional(),
  capacityOperationalMw: z.number().positive().optional(),
  capacityPlannedMw: z.number().positive().optional(),
  sourceUrl: httpUrlSchema,
  sourceLabel: z.string().max(200).optional(),
  note: z.string().max(2000).optional(),
});

const correctionSchema = z.object({
  kind: z.literal("correction"),
  website: z.string().max(200).optional(),
  targetFacilityId: z.string().min(1),
  field: z.enum(CORRECTABLE_KEYS),
  value: z.union([z.string().max(2000), z.number()]),
  sourceUrl: httpUrlSchema,
  note: z.string().max(2000).optional(),
});

export const contributeInputSchema = z.discriminatedUnion("kind", [
  createSchema,
  correctionSchema,
]);

export type ContributeInput = z.infer<typeof contributeInputSchema>;
export type CreateContributeInput = z.infer<typeof createSchema>;
export type CorrectionContributeInput = z.infer<typeof correctionSchema>;

export function isHoneypotTripped(input: { website?: string }): boolean {
  return Boolean(input.website && input.website.trim());
}

export function slugify(name: string, state: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return `${base}-${state.toLowerCase()}`;
}

export function buildCreatePayload(
  input: CreateContributeInput,
  today: string
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: slugify(input.name, input.state),
    name: input.name,
    operator: input.operator,
    status: input.status,
    confidence: "rumored",
    facilityType: input.facilityType,
    location: {
      lat: input.lat,
      lon: input.lon,
      state: input.state.toUpperCase(),
      ...(input.city ? { city: input.city } : {}),
      precision: "approximate",
    },
    sources: [
      {
        url: input.sourceUrl,
        label: input.sourceLabel?.trim() || "User-submitted source",
        retrievedAt: today,
        kind: "other",
      },
    ],
    lastUpdated: today,
  };

  if (input.capacityOperationalMw !== undefined || input.capacityPlannedMw !== undefined) {
    payload.capacityMw = {
      ...(input.capacityPlannedMw !== undefined ? { planned: input.capacityPlannedMw } : {}),
      ...(input.capacityOperationalMw !== undefined ? { operational: input.capacityOperationalMw } : {}),
    };
  }

  return payload;
}

interface CorrectableFieldDef {
  key: CorrectableKey;
  label: string;
  valueKind: "text" | "number" | "enum" | "state";
  enumValues?: readonly string[];
  apply: (existing: Facility, value: string | number) => Record<string, unknown>;
}

const APPLY_FNS: Record<
  CorrectableKey,
  (existing: Facility, value: string | number) => Record<string, unknown>
> = {
  name: (_existing, value) => ({ name: String(value) }),
  operator: (_existing, value) => ({ operator: String(value) }),
  poweredBy: (_existing, value) => ({ poweredBy: String(value) }),
  status: (_existing, value) => ({ status: value }),
  state: (existing, value) => ({
    location: { ...existing.location, state: String(value).toUpperCase() },
  }),
  capacityOperationalMw: (existing, value) => ({
    capacityMw: { ...existing.capacityMw, operational: Number(value) },
  }),
  capacityPlannedMw: (existing, value) => ({
    capacityMw: { ...existing.capacityMw, planned: Number(value) },
  }),
};

export const CORRECTABLE_FIELDS: CorrectableFieldDef[] = CORRECTABLE_FIELD_META.map(
  (meta) => ({
    ...meta,
    apply: APPLY_FNS[meta.key],
  })
);

function validateFieldValue(
  def: CorrectableFieldDef,
  value: string | number
): { ok: true } | { ok: false; error: string } {
  switch (def.valueKind) {
    case "text": {
      const str = String(value).trim();
      if (str.length === 0 || str.length > 200) {
        return { ok: false, error: `${def.label} must be 1-200 characters` };
      }
      return { ok: true };
    }
    case "number": {
      const num = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(num) || num <= 0) {
        return { ok: false, error: `${def.label} must be a positive number` };
      }
      return { ok: true };
    }
    case "enum": {
      if (!def.enumValues?.includes(String(value))) {
        return { ok: false, error: `${def.label} must be one of: ${def.enumValues?.join(", ")}` };
      }
      return { ok: true };
    }
    case "state": {
      if (String(value).trim().length !== 2) {
        return { ok: false, error: `${def.label} must be a 2-letter code` };
      }
      return { ok: true };
    }
    default:
      return { ok: false, error: "Unsupported field" };
  }
}

export function buildCorrectionPatch(
  existing: Facility,
  input: CorrectionContributeInput,
  today: string
): { payload: Record<string, unknown> } | { error: string } {
  const def = CORRECTABLE_FIELDS.find((f) => f.key === input.field);
  if (!def) {
    return { error: `Unknown correctable field: ${input.field}` };
  }

  const validation = validateFieldValue(def, input.value);
  if (!validation.ok) {
    return { error: validation.error };
  }

  const patch = def.apply(existing, input.value);
  const correctionSource = {
    url: input.sourceUrl,
    label: "Correction source",
    retrievedAt: today,
    kind: "other" as const,
  };
  patch.sources = [...existing.sources, correctionSource];

  return { payload: patch };
}

export async function submitContribution(
  rawInput: unknown,
  ipHash: string,
  today: string = new Date().toISOString().slice(0, 10)
): Promise<
  | { ok: true }
  | { ok: false; status: number; error: string; issues?: unknown }
> {
  const parsed = contributeInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid submission", issues: parsed.error.issues };
  }
  const data = parsed.data;

  if (isHoneypotTripped(data)) {
    return { ok: true };
  }

  if (data.kind === "create") {
    const payload = buildCreatePayload(data, today);
    const validated = facilitySchema.safeParse(payload);
    if (!validated.success) {
      return { ok: false, status: 400, error: "Invalid facility data", issues: validated.error.issues };
    }
    const result = await createSubmission({
      kind: "create",
      payload,
      provenance: {
        sources: [data.sourceUrl],
        discoveredBy: "public-contribution",
        confidence: "rumored",
        note: data.note,
        submitterIpHash: ipHash,
      },
    });
    if (!result.ok) return result;
    return { ok: true };
  }

  const existing = await getFacilityById(data.targetFacilityId);
  if (!existing) {
    return { ok: false, status: 404, error: "Facility not found" };
  }
  const patchResult = buildCorrectionPatch(existing, data, today);
  if ("error" in patchResult) {
    return { ok: false, status: 400, error: patchResult.error };
  }
  const preview = { ...existing, ...patchResult.payload, id: existing.id };
  const previewValidated = facilitySchema.safeParse(preview);
  if (!previewValidated.success) {
    return { ok: false, status: 400, error: "Invalid correction", issues: previewValidated.error.issues };
  }
  const result = await createSubmission({
    kind: "update",
    targetFacilityId: existing.id,
    payload: patchResult.payload,
    provenance: {
      sources: [data.sourceUrl],
      discoveredBy: "public-correction",
      note: data.note,
      submitterIpHash: ipHash,
    },
  });
  if (!result.ok) return result;
  return { ok: true };
}
