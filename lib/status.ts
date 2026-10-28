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
    hex: "#B45309",
  },
  permitted: {
    label: "Permitted",
    description: "Approved/permitted, not yet under construction.",
    icon: FileCheck,
    colorVar: "--status-permitted",
    hex: "#007A53",
  },
  proposed: {
    label: "Proposed",
    description: "Announced or proposed; not yet approved.",
    icon: CircleDashed,
    colorVar: "--status-proposed",
    hex: "#9D2C6F",
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
 * Narrows a URL segment to a Status, or undefined for anything that is not one
 * of the five known values. Shared by the /status/[status] page and its share
 * card so both resolve a slug identically.
 */
export function parseStatus(raw: string): Status | undefined {
  return STATUS_ORDER.find((s) => s === raw);
}

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
