import { getStatusMeta, getStatusColor } from "@/lib/status";
import type { Status } from "@/lib/status";
import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: Status;
  className?: string;
  /**
   * Drop the icon. The label still carries the status in text, so it is not
   * color alone; long index lists use this to avoid repeating an inline SVG per row.
   */
  hideIcon?: boolean;
}

/**
 * Renders a status badge with icon + label in the status color.
 * Icon is aria-hidden; the status is conveyed by both shape and color (never color alone).
 * Styled as a map-legend entry: mono uppercase tracking-wider.
 */
export function StatusBadge({ status, className, hideIcon = false }: StatusBadgeProps) {
  const meta = getStatusMeta(status);
  const Icon = meta.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-wider",
        className,
      )}
      style={{ color: getStatusColor(status) }}
    >
      {!hideIcon && <Icon aria-hidden="true" className="size-3.5 shrink-0" />}
      {meta.label}
    </span>
  );
}
