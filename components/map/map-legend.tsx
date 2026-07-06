"use client";

import { STATUS_ORDER, STATUS_META, getStatusColor } from "@/lib/status";

/**
 * Compact legend overlay for the facility map.
 * Positioned absolutely in the bottom-left of its containing element.
 * Semi-opaque background ensures sufficient contrast over the basemap.
 */
export function MapLegend() {
  return (
    <div
      role="region"
      aria-label="Map legend — facility build status"
      className="absolute bottom-8 left-2 z-10 bg-background/95 backdrop-blur-sm border border-border rounded-lg p-3 shadow-md pointer-events-none text-foreground"
    >
      <h2 className="text-xs font-semibold mb-2 text-foreground">
        Build status
      </h2>
      <ul role="list" className="space-y-1.5">
        {STATUS_ORDER.map((status) => {
          const meta = STATUS_META[status];
          const Icon = meta.icon;
          return (
            <li key={status} className="flex items-center gap-2">
              <Icon
                aria-hidden="true"
                className="size-3.5 shrink-0"
                style={{ color: getStatusColor(status) }}
              />
              <span className="text-xs text-foreground">{meta.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
