import {
  CircleCheck,
  Construction,
  FileCheck,
  CircleDashed,
  CircleX,
  type LucideIcon,
} from "lucide-react";

export const STATUS_ORDER = [
  "operational",
  "under_construction",
  "permitted",
  "proposed",
  "cancelled",
] as const;

export type Status = (typeof STATUS_ORDER)[number];

export interface StatusMeta {
  label: string;
  description: string;
  icon: LucideIcon;
  /** CSS custom property token name, e.g. "--status-operational" */
  colorVar: string;
  /** Wong palette hex for reference / static use */
  hex: string;
}

export const STATUS_META: Record<Status, StatusMeta> = {
  operational: {
    label: "Operational",
    description: "Built and running.",
    icon: CircleCheck,
    colorVar: "--status-operational",
    hex: "#0072B2",
  },
  under_construction: {
    label: "Under construction",
    description: "Actively being built.",
    icon: Construction,
    colorVar: "--status-under-construction",
    hex: "#E69F00",
  },
  permitted: {
    label: "Permitted",
    description: "Approved/permitted, not yet under construction.",
    icon: FileCheck,
    colorVar: "--status-permitted",
    hex: "#009E73",
  },
  proposed: {
    label: "Proposed",
    description: "Announced or proposed; not yet approved.",
    icon: CircleDashed,
    colorVar: "--status-proposed",
    hex: "#CC79A7",
  },
  cancelled: {
    label: "Cancelled",
    description: "Cancelled or withdrawn.",
    icon: CircleX,
    colorVar: "--status-cancelled",
    hex: "#6B7280",
  },
};

/**
 * Returns the StatusMeta for a given status value.
 */
export function getStatusMeta(s: Status): StatusMeta {
  return STATUS_META[s];
}

/**
 * Returns a CSS var() expression for a status color, suitable for inline styles.
 * e.g. getStatusColor("operational") → "var(--status-operational)"
 */
export function getStatusColor(s: Status): string {
  return `var(${STATUS_META[s].colorVar})`;
}
