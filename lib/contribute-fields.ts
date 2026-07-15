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
];
