import { getStatusMeta, getStatusColor } from "@/lib/status";
import type { Status } from "@/lib/status";
import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: Status;
  className?: string;
}

/**
 * Renders a status badge with icon + label in the status color.
 * Icon is aria-hidden; the status is conveyed by both shape and color (never color alone).
 */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  const meta = getStatusMeta(status);
  const Icon = meta.icon;

  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-sm font-medium", className)}
      style={{ color: getStatusColor(status) }}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {meta.label}
    </span>
  );
}
