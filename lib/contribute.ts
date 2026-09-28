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
import { stateNameFromCode } from "@/lib/us-states";

export { CORRECTABLE_KEYS } from "@/lib/contribute-fields";
// Re-exported so existing callers (this module's own tests, lib/leads.ts
// previously) keep working. The canonical definitions live in the
// client-safe "@/lib/intake-fields" leaf — see that file's header.
export { httpUrlSchema, sanitizeAttribution } from "@/lib/intake-fields";

// slugify
const SLUG_NON_ALNUM_RE = /[^a-z0-9]+/g;
const SLUG_EDGE_DASHES_RE = /^-+|-+$/g;
const SLUG_DASH_RUN_RE = /-+/g;

/**
 * A real US jurisdiction code, resolved through `stateNameFromCode` (states, DC
 * and territories) rather than merely counted to two characters.
 *
 * `z.string().length(2)` was the whole check, so `"ZZ"` staged a `pending`
 * submission and `lib/schema.ts`'s `facilitySchema` accepted it too (its
 * `location.state` is `z.string().length(2)` as well) — the bad code only
 * surfaced under human review, as queue noise. `subscribeToTarget`
 * (lib/subscribe.ts) has always resolved its target state this way; this is the
 * same check, at the other intake.
 *
 * The `code.length !== 2` escape in the refinement is deliberate: Zod v4 runs a
 * `.refine()` even when an earlier check in the chain already failed, so without
 * it a value like `"Virginia"` would collect BOTH the length issue and the
 * unknown-code one, and the contribute form (which keys errors by
 * `issue.path[0]`) would show whichever it happened to pick. Letting the
 * refinement pass on any non-2-character input leaves `.length(2)` to report
 * that case alone, so every input yields exactly one issue for this field.
 */
const usStateCodeSchema = z
  .string()
  .length(2)
  .refine((code) => code.length !== 2 || stateNameFromCode(code) !== undefined, {
    message: "Unknown US state or territory code",
  });

const createSchema = z.object({
  kind: z.literal("create"),
  website: z.string().max(200).optional(),
  // `min(1)` is not enough: a punctuation-only name ("...", "---", "•") is a
  // non-empty string whose `slugBase` is EMPTY, so `slugify` produced a bare
  // `"-xx"` id, which `lib/schema.ts`'s `/^[a-z0-9-]+$/` id pattern happily
  // accepts. Requiring a non-empty slug base is what rejects it, and it is
  // checked with the same expression the id is built from (see `slugBase`).
  //
  // The `value.length === 0` escape mirrors `usStateCodeSchema`'s: Zod v4 runs a
  // refinement even after `min(1)` fails, so without it an empty name would
  // report two issues for one field.
  name: z
    .string()
    .min(1)
    .max(200)
    .refine((value) => value.length === 0 || slugBase(value).length > 0, {
      message: "Name must contain at least one letter or number",
    }),
  operator: z.string().min(1).max(200),
  state: usStateCodeSchema,
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

/**
 * The shared honeypot predicate for every public intake surface (contribute,
 * leads, contact, access/request). Called against the RAW request body, before
 * any schema parsing — see the honeypot comment in app/api/contribute/route.ts.
 *
 * Takes `unknown`, not `string`, ON PURPOSE. It used to be
 * `Boolean(input.website && input.website.trim())` behind a
 * `typeof rawWebsite === "string"` gate at each call site, and that TYPE gate
 * was itself the oracle the honeypot exists to avoid:
 * `{"website":1,"email":"bad"}` fell past it into Zod and answered 400 with
 * `issues`, while `{"website":"x","email":"bad"}` answered 201. Flipping one
 * field's type therefore told a bot two things at once — that `website` is the
 * honeypot, and that its other fields were what actually failed. Every type
 * must answer identically, so the check coerces instead of narrowing.
 *
 * Tripped by any PRESENT value that is non-empty after `String(v).trim()`:
 * `"x"`, `" x "`, `1`, `0`, `true`, `{}`, `["x"]`.
 *
 * NOT tripped by `undefined` (absent), `null`, `false`, `""`, `"   "` or `[]` —
 * "present but not filled in." `""` is the load-bearing one: a real browser
 * submits the hidden input as an empty string on every honest submission, so
 * treating it as filled would reject every real contributor. `null` and `false`
 * are included because they are the JSON spellings of the same "no value," and
 * `String()` would otherwise coerce them to the non-empty `"null"`/`"false"`.
 */
export function isHoneypotTripped(input: { website?: unknown }): boolean {
  const value = input.website;
  if (value === undefined || value === null || value === false) return false;
  return String(value).trim().length > 0;
}

/**
 * The slug-safe part of an id, derived from a facility name alone. Split out of
 * `slugify` so the intake validation that REQUIRES a non-empty base (see
 * `createSchema.name` below) computes it with the exact same expression the id
 * is built from, rather than a second regex that can drift.
 */
export function slugBase(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(SLUG_NON_ALNUM_RE, "-")
    .replace(SLUG_EDGE_DASHES_RE, "")
    .replace(SLUG_DASH_RUN_RE, "-");
}

export function slugify(name: string, state: string): string {
  return `${slugBase(name)}-${state.toLowerCase()}`;
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
      const code = String(value).trim();
      if (code.length !== 2) {
        return { ok: false, error: `${def.label} must be a 2-letter code` };
      }
      // Resolved against the real jurisdiction list, not just counted —
      // otherwise a correction could set an existing facility's state to "ZZ",
      // which `facilitySchema` (also `z.string().length(2)`) would pass. Same
      // check as `usStateCodeSchema` above; this is the correction-path door
      // into the same field.
      if (stateNameFromCode(code) === undefined) {
        return { ok: false, error: `${def.label} must be a real US state or territory code` };
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
 * Best-effort "email me when reviewed" side effect. Called by the ROUTE
 * inside `after()`, never awaited inline in `submitContribution` — see the
 * timing note on `ContributeResult`'s `notify` field below. (Prior
 * security-review fix: this used to be awaited inline at both call sites,
 * which made response latency differ by whether the supplied address was
 * already at its per-address cap — one query — versus under it — a second
 * INSERT — leaking that fact to an unauthenticated caller.)
 *
 * Mirrors `approveSubmission`'s wrap around `notifySubscribersOfChange`
 * (lib/submissions.ts): a failure here — whether from the cap check or the
 * insert — must never turn a successful submission into an error response,
 * so it is swallowed and logged. Once deferred via `after()` that's true
 * structurally too (the response has already gone out), but the try/catch
 * predates the deferral and stays regardless.
 *
 * Logs only a safe error code, never the caught error object:
 * `recordSubmissionNotifyRequest`'s insert binds `email`, and
 * `DrizzleQueryError.message` embeds bound query params, so logging the raw
 * error here would leak the contributor's address to server logs — the same
 * incident class that previously happened with an IP hash.
 */
export async function recordNotifyRequestBestEffort(submissionId: string, email: string): Promise<void> {
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

/**
 * `notify`, when present, is NOT sent to the HTTP caller — the route reads
 * it to schedule `recordNotifyRequestBestEffort` AFTER the response goes out
 * (via next/server's `after()`), exactly like `SubscribeResult`'s `confirm`
 * field (lib/subscribe.ts) schedules the confirm-email send. See that type's
 * doc comment for the full timing rationale; short version: awaiting the
 * notify write inline made response latency reveal whether the caller's
 * address was already at its per-address cap.
 */
export type ContributeResult =
  | { ok: true; notify?: { submissionId: string; email: string } }
  | { ok: false; status: number; error: string; issues?: unknown };

export async function submitContribution(
  rawInput: unknown,
  ipHash: string,
  today: string = new Date().toISOString().slice(0, 10)
): Promise<ContributeResult> {
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
    // The notify row is NOT written here — see ContributeResult's doc
    // comment above for why this returns a signal instead of awaiting
    // recordNotifyRequestBestEffort inline.
    return notifyEmail
      ? { ok: true, notify: { submissionId: result.id, email: notifyEmail } }
      : { ok: true };
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
  // Same timing rationale as the create branch above.
  return notifyEmail
    ? { ok: true, notify: { submissionId: result.id, email: notifyEmail } }
    : { ok: true };
}
