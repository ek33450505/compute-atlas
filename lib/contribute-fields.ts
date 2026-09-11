import { STATUS_ORDER } from "@/lib/status"; // client-safe (only imports lucide icons)
import { communityStatusEnum, energySourceEnum, waterCoolingTypeEnum } from "@/lib/schema";
// lib/schema.ts is client-safe: it only imports zod + the client-safe
// lib/status and lib/intake-fields leaves (no lib/db/client, lib/submissions,
// lib/contribute, or lib/facility-write) and is already pulled into client
// bundles elsewhere (e.g. components/explorer/explorer.tsx imports
// facilityTypeEnum from it at runtime). See lib/lead-fields.guard.test.ts for
// the failure mode this note is guarding against.

/** Fields a public correction may target. Keep in sync with the server apply
 *  registry in lib/contribute.ts (which imports these).
 *
 *  Widened 2026-09-11 (Ed, fresh go-ahead) to add water/energy/emissions/
 *  community on top of the original 9 — the prior staged-rollout note below
 *  this comment block deferred them pending real review volume on
 *  subsidies/jobs; that volume is now known and Ed signed off on widening
 *  further. `stakeholders` is deliberately NOT included: CLAUDE.md states
 *  stakeholders are "site-level curated, excluded from public intake and
 *  discovery enrichment," and stakeholderSchema names a real, specific
 *  person — an anonymous public correction naming someone is a materially
 *  different risk (misattribution/defamation) than correcting a number or
 *  enum, and is not covered by this go-ahead. See lib/contribute.ts's
 *  APPLY_FNS for the per-field editorial-risk reasoning on water/energy/
 *  emissions. */
export const CORRECTABLE_KEYS = [
  "name",
  "operator",
  "poweredBy",
  "status",
  "state",
  "capacityOperationalMw",
  "capacityPlannedMw",
  "subsidies",
  "jobs",
  "water",
  "energy",
  "emissions",
  "community",
] as const;

export type CorrectableKey = (typeof CORRECTABLE_KEYS)[number];
export type CorrectableValueKind = "text" | "number" | "enum" | "state";

export interface CorrectableFieldMeta {
  key: CorrectableKey;
  label: string;
  valueKind: CorrectableValueKind;
  enumValues?: readonly string[];
}

export const CORRECTABLE_FIELD_META: readonly CorrectableFieldMeta[] = [
  { key: "name", label: "Facility name", valueKind: "text" },
  { key: "operator", label: "Operator", valueKind: "text" },
  { key: "poweredBy", label: "Powered by", valueKind: "text" },
  { key: "status", label: "Status", valueKind: "enum", enumValues: STATUS_ORDER },
  { key: "state", label: "State", valueKind: "state" },
  { key: "capacityOperationalMw", label: "Operational capacity (MW)", valueKind: "number" },
  { key: "capacityPlannedMw", label: "Planned capacity (MW)", valueKind: "number" },
  // Adds a new subsidy record with this dollar amount rather than editing an
  // existing one — matches how a correction always appends a new source
  // (see buildCorrectionPatch in lib/contribute.ts), and keeps the value a
  // single checkable number per the staged-rollout rationale (factual,
  // source-verifiable) rather than free text. Label makes clear this creates
  // a new record, not an edit, so the submitter's cited source (entered
  // elsewhere in the correction dialog) is what backs the program/year
  // context that this field alone can't capture.
  { key: "subsidies", label: "Subsidy amount (USD) — new record", valueKind: "number" },
  // Targets jobs.permanent specifically (the figure most commonly reported
  // in press/community materials); jobs.construction is not correctable via
  // this key.
  { key: "jobs", label: "Permanent jobs", valueKind: "number" },
  // Targets water.coolingType specifically — the enum values (and the
  // recirculating-circuit tie-breaker that resolves the common "marketed as
  // air-cooled but actually closed-loop" case) live in lib/schema.ts, read
  // alongside this field. reportedMgd/notes are not correctable via this key.
  {
    key: "water",
    label: "Cooling type",
    valueKind: "enum",
    enumValues: waterCoolingTypeEnum.options,
  },
  // Targets energy.source specifically; utility/onSiteGenerationMw/notes are
  // not correctable via this key.
  {
    key: "energy",
    label: "Energy source",
    valueKind: "enum",
    enumValues: energySourceEnum.options,
  },
  // Targets emissions.permitNumber specifically — a citable document
  // identifier, not a tonnage. emissionsSchema requires `basis` whenever a
  // permittedTpy pollutant is set (facility-wide vs per-unit — see the
  // schema's superRefine), a distinction a single-value public correction
  // cannot safely assert; permitNumber carries none of that risk and is the
  // one sub-field here a member of the public can correct with a single
  // string, same as operator/poweredBy. Every other emissions sub-field
  // (permittedTpy.*, unitGroups, basis, averagingPeriod) is out of scope for
  // this key.
  { key: "emissions", label: "Air permit number", valueKind: "text" },
  // Targets community.status specifically; community.notes is not
  // correctable via this key (free text with no single-value shape).
  {
    key: "community",
    label: "Community response",
    valueKind: "enum",
    enumValues: communityStatusEnum.options,
  },
];
