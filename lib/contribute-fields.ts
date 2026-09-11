import { STATUS_ORDER } from "@/lib/status"; // client-safe (only imports lucide icons)

/** Fields a public correction may target. Keep in sync with the server apply
 *  registry in lib/contribute.ts (which imports these). */
export const CORRECTABLE_KEYS = [
  "name",
  "operator",
  "poweredBy",
  "status",
  "state",
  "capacityOperationalMw",
  "capacityPlannedMw",
  // STAGED ROLLOUT (2026-09-10): Ed approved widening this list to include
  // water/energy/emissions/community/stakeholders too, but those need more
  // editorial judgment at review time than these two — deferred to a
  // fast-follow PR once real review volume on subsidies/jobs is known. Do
  // not add them here without a fresh decision from Ed.
  "subsidies",
  "jobs",
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
];
