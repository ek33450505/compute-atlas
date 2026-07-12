"use client";

import { STATUS_ORDER, STATUS_META, getStatusColor } from "@/lib/status";
import { FACILITY_TYPE_ORDER, FACILITY_TYPE_META } from "@/lib/facility-type";

/**
 * Engraved print-cartography legend overlay for the facility map — a "Key to
 * Symbols" panel styled after a map key on a printed atlas plate.
 * Positioned absolutely in the bottom-left of its containing element.
 * Opaque parchment background + double neatline separate it from the basemap.
 */
export function MapLegend() {
  return (
    <div
      role="region"
      aria-label="Key to symbols — facility status and type"
      className="absolute bottom-8 left-2 z-10 select-none rounded-sm border border-border bg-popover p-[3px] pointer-events-none text-foreground"
    >
      <div className="rounded-[1px] border border-border/50 px-3 py-2.5">
        <p className="mb-2 border-b border-border/60 pb-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Key to symbols
        </p>
        <p className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Build status
        </p>
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
        <p className="mt-3 mb-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Facility type
        </p>
        <ul role="list" className="space-y-1.5">
          {FACILITY_TYPE_ORDER.map((type) => {
            const meta = FACILITY_TYPE_META[type];
            const shapeClassName =
              type === "crypto_mining"
                ? "rounded-md"
                : type === "power_generation"
                  ? "rounded-none"
                  : "rounded-full";
            return (
              <li key={type} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`size-3.5 shrink-0 border border-foreground/60 ${shapeClassName}`}
                />
                <span className="text-xs text-foreground">{meta.label}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
