import type { ReactNode } from "react";
import Link from "next/link";

import type { Facility } from "@/lib/schema";
import { formatCapacity } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";

export interface FacilityListRowProps {
  facility: Facility;
  /**
   * Secondary line under the facility name. Content differs per caller
   * (operator·location, location only, technology·location) and isn't
   * derivable from `facility` alone, so callers supply it directly.
   */
  secondary: ReactNode;
}

/**
 * One row of a facility `<ul>`/`<ol>` list: name + secondary line on the
 * left, StatusBadge + capacity on the right. Shared by /states/[state],
 * /operators/[operator], /crypto, /rankings' "Biggest projects" section, and
 * /power's offtaker groups + "All projects" section — each caller's `<li>`
 * wraps this component. Deliberately renders only the `<Link>` row, not the
 * `<li>`/list wrapper, since that varies by caller (`<ol>` on /rankings,
 * `<ul>` elsewhere).
 */
export function FacilityListRow({ facility, secondary }: FacilityListRowProps) {
  return (
    <Link
      href={`/facilities/${facility.id}`}
      className="flex min-h-11 flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
    >
      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm text-foreground truncate">{facility.name}</span>
        <span className="text-xs text-muted-foreground truncate">{secondary}</span>
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <StatusBadge status={facility.status} />
        <span className="font-mono tabular-nums text-xs text-muted-foreground">
          {formatCapacity(facility)}
        </span>
      </span>
    </Link>
  );
}
