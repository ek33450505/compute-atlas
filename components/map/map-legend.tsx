"use client";

import { useState } from "react";

import { STATUS_ORDER, STATUS_META, getStatusColor } from "@/lib/status";
import { FACILITY_TYPE_ORDER, FACILITY_TYPE_META } from "@/lib/facility-type";

const PANEL_ID = "map-legend-panel";

/**
 * Engraved print-cartography legend overlay for the facility map — a "Key to
 * Symbols" panel styled after a map key on a printed atlas plate.
 * Positioned absolutely in the bottom-left of its containing element.
 *
 * The "Key to symbols" title header IS the toggle — there is no separate
 * chip button, so the label is never duplicated. Collapsed by default on
 * every viewport (desktop included), so it never covers a share of the map
 * canvas until the visitor asks for it; clicking the header reveals the
 * Build status + Facility type lists below it, inside the same parchment
 * neatline panel, and clicking again collapses them.
 */
export function MapLegend() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      role="region"
      aria-label="Key to symbols — facility status and type"
      className="pointer-events-auto absolute bottom-8 left-2 z-10 select-none text-foreground"
    >
      <div className="rounded-sm border border-border bg-popover p-[3px]">
        <div className="rounded-[1px] border border-border/50">
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            aria-controls={PANEL_ID}
            className="flex min-h-11 w-full cursor-pointer items-center gap-1.5 px-3 py-2.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          >
            <span aria-hidden="true">⌖</span>
            <span>Key to symbols</span>
            <span
              className={`ml-auto inline-flex transition-transform duration-150 ease-in-out motion-reduce:transition-none ${
                expanded ? "rotate-180" : "rotate-0"
              }`}
              aria-hidden="true"
            >
              <svg viewBox="0 0 16 16" width="10" height="10">
                <polyline
                  points="3,5 8,11 13,5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </button>

          {expanded && (
            <div id={PANEL_ID} className="border-t border-border/60 px-3 py-2.5">
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
          )}
        </div>
      </div>
    </div>
  );
}
