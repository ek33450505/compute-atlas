import { z } from "zod";

import { createSubmission } from "@/lib/submissions";
import { facilitySchema, type Facility } from "@/lib/schema";
import { getFacilityById } from "@/lib/data";
import {
  CORRECTABLE_KEYS,
  CORRECTABLE_FIELD_META,
  type CorrectableKey,
} from "@/lib/contribute-fields";
import { httpUrlSchema, sanitizeAttribution } from "@/lib/intake-fields";
import { checkSubmissionNotifyCap } from "@/lib/rate-limit";
import { recordSubmissionNotifyRequest, submissionNotifyEnabled } from "@/lib/submission-notify";

export { CORRECTABLE_KEYS } from "@/lib/contribute-fields";
// Re-exported so existing callers (this module's own tests, lib/leads.ts
// previously) keep working. The canonical definitions live in the
// client-safe "@/lib/intake-fields" leaf — see that file's header.
export { httpUrlSchema, sanitizeAttribution } from "@/lib/intake-fields";

// slugify
const SLUG_NON_ALNUM_RE = /[^a-z0-9]+/g;
const SLUG_EDGE_DASHES_RE = /^-+|-+$/g;
const SLUG_DASH_RUN_RE = /-+/g;

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
  attribution: z.string().max(80).optional(),
});

const correctionSchema = z.object({
  kind: z.literal("correction"),
  website: z.string().max(200).optional(),
  targetFacilityId: z.string().min(1),
  field: z.enum(CORRECTABLE_KEYS),
  value: z.union([z.string().max(2000), z.number()]),
  sourceUrl: httpUrlSchema,
  note: z.string().max(2000).optional(),
  attribution: z.string().max(80).optional(),
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
    .replace(SLUG_NON_ALNUM_RE, "-")
    .replace(SLUG_EDGE_DASHES_RE, "")
    .replace(SLUG_DASH_RUN_RE, "-");
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
  // Appends a new subsidy record rather than overwriting the array — a
  // correction here is "I found a subsidy the record doesn't list yet."
  // `program`/`jurisdiction`/`year` are NOT capturable via this key — the
  // correction UI's `valueKind` only supports a single text/number/enum/state
  // value, and a composite subsidy entry needs a dedicated multi-field form.
  // That is a fast-follow, not this pass; do not assume the record is
  // complete just because it validates.
  //
  // `sourceIndex` is set to `existing.sources.length` — buildCorrectionPatch
  // (below) calls `apply()` BEFORE appending the correction's own source via
  // `patch.sources = [...existing.sources, correctionSource]`, so that index
  // is exactly where the new source will land. A bare amountUsd with no
  // sourceIndex would be unattributable to the source the contributor cited —
  // this dataset's worst data-quality incident was conflating a bond
  // authorization ceiling with a disbursed abatement, an error class this
  // guards against by keeping every subsidy figure traceable to its source.
  subsidies: (existing, value) => ({
    subsidies: [
      ...(existing.subsidies ?? []),
      { amountUsd: Number(value), sourceIndex: existing.sources.length },
    ],
  }),
  jobs: (existing, value) => ({
    jobs: { ...existing.jobs, permanent: Number(value) },
  }),
  // Merges into the existing water object rather than replacing it, so a
  // coolingType correction never clobbers reportedMgd/notes. See
  // lib/schema.ts's tie-breaker comment on waterCoolingTypeEnum before
  // assuming "air-cooled" marketing copy means this value is "air".
  water: (existing, value) => ({
    water: { ...existing.water, coolingType: value },
  }),
  energy: (existing, value) => ({
    energy: { ...existing.energy, source: value },
  }),
  // permitNumber only — see the CORRECTABLE_FIELD_META comment in
  // lib/contribute-fields.ts for why the tonnage sub-fields
  // (permittedTpy.*, basis, unitGroups) are deliberately NOT wired through
  // this single-value correction path.
  emissions: (existing, value) => ({
    emissions: { ...existing.emissions, permitNumber: String(value) },
  }),
  // community.notes is not touched — a correction here only ever changes the
  // status enum, never the free-text explanation of it.
  community: (existing, value) => ({
    community: { ...existing.community, status: value },
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

// Validates a `notifyEmail` value ONLY when the feature is enabled (see
// below) — never part of `contributeInputSchema`. See that decision's
// rationale at the read site in `submitContribution`. Unlike
// lib/subscribe.ts's/lib/access-grants.ts's `email` field (which validates
// the raw value, then normalizes separately), this one trims + lowercases
// BEFORE the `.email()`/`.max()` checks — a raw value with incidental
// whitespace should still be treated as the address it obviously is, not
// rejected as malformed.
const notifyEmailSchema = z.string().trim().toLowerCase().email().max(254);

// Wrapped in a one-key object rather than parsed as a bare string so a
// validation failure's `issue.path` is `["notifyEmail"]`, not `[]` — a
// path-less issue can't be attached to a field by the form's client-side
// issuesToFieldMap (components/contribute/field-primitives.tsx), which keys
// errors by `issue.path[0]`. (Flagged by the frontend unit, which had worked
// around the empty path client-side; fixing the shape here removes the need
// for that workaround.)
const notifyEmailFieldSchema = z.object({ notifyEmail: notifyEmailSchema });

/**
 * Best-effort "email me when reviewed" side effect, run AFTER a submission
 * has already been created successfully. Mirrors `approveSubmission`'s wrap
 * around `notifySubscribersOfChange` (lib/submissions.ts): a failure here —
 * whether from the cap check or the insert — must never turn a successful
 * submission into an error response, so it is swallowed and logged.
 *
 * Logs only a safe error code, never the caught error object:
 * `recordSubmissionNotifyRequest`'s insert binds `email`, and
 * `DrizzleQueryError.message` embeds bound query params, so logging the raw
 * error here would leak the contributor's address to server logs — the same
 * incident class that previously happened with an IP hash.
 */
async function recordNotifyRequestBestEffort(submissionId: string, email: string): Promise<void> {
  try {
    const cap = await checkSubmissionNotifyCap(email);
    if (!cap.ok) {
      return; // over the per-address cap — no row; same generic success either way
    }
    await recordSubmissionNotifyRequest(submissionId, email);
  } catch (err) {
    const code =
      (err as { code?: string } | undefined)?.code ??
      (err as { cause?: { code?: string } } | undefined)?.cause?.code ??
      "unknown";
    console.error("submission notify request failed", code);
  }
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
  const attribution = sanitizeAttribution(data.attribution);

  if (isHoneypotTripped(data)) {
    return { ok: true };
  }

  // "Email me when reviewed" — deliberately NOT a field on
  // `contributeInputSchema` (see the `submissionNotifyRequestsTable` doc
  // comment in lib/db/schema.ts). A Zod object silently strips unknown keys,
  // so today a request carrying `notifyEmail` already succeeds with the
  // field discarded. Adding it to the always-on schema with `.email()`/
  // `.max()` validation would make a malformed value 400 EVEN WITH THE FLAG
  // OFF — an oracle revealing the feature exists before it's live. So: read
  // and validate this key ONLY when the flag is on; with it off, behavior
  // and response are byte-identical to before this feature existed.
  let notifyEmail: string | undefined;
  if (submissionNotifyEnabled()) {
    const rawNotifyEmail =
      rawInput && typeof rawInput === "object" && "notifyEmail" in rawInput
        ? (rawInput as { notifyEmail?: unknown }).notifyEmail
        : undefined;
    if (rawNotifyEmail !== undefined) {
      const parsedEmail = notifyEmailFieldSchema.safeParse({ notifyEmail: rawNotifyEmail });
      if (!parsedEmail.success) {
        return {
          ok: false,
          status: 400,
          error: "Invalid notify email",
          issues: parsedEmail.error.issues,
        };
      }
      notifyEmail = parsedEmail.data.notifyEmail; // already trimmed + lowercased by the schema above
    }
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
        ...(attribution ? { attribution } : {}),
      },
    });
    if (!result.ok) return result;
    if (notifyEmail) {
      await recordNotifyRequestBestEffort(result.id, notifyEmail);
    }
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
      ...(attribution ? { attribution } : {}),
    },
  });
  if (!result.ok) return result;
  if (notifyEmail) {
    await recordNotifyRequestBestEffort(result.id, notifyEmail);
  }
  return { ok: true };
}
