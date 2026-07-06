"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { ExternalLink, X } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import type { Facility } from "@/lib/schema";

interface FacilityPopupProps {
  facility: Facility;
  onClose: () => void;
}

/**
 * Content rendered inside a react-map-gl <Popup> when a marker is selected.
 *
 * Accessibility contract:
 * - Focus moves to the close button on mount
 * - Escape key closes the popup (keydown listener scoped to document, cleaned up on unmount)
 * - External source link includes "opens in new tab" in its aria-label
 * - "View details →" link target (/facilities/:id) is M4; the link is safe to include now
 * - Close button returns focus to the triggering marker (managed by FacilityMap parent)
 */
export function FacilityPopup({ facility, onClose }: FacilityPopupProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Move focus to the close button when the popup opens
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () =>
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [onClose]);

  const { location, capacityMw, sources, aiClassification, confidence } =
    facility;
  const firstSource = sources[0];
  const cityState = location.city
    ? `${location.city}, ${location.state}`
    : location.state;

  return (
    <div className="p-1 min-w-[220px] max-w-[280px]">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-1">
        <h3 className="text-sm font-semibold leading-tight">{facility.name}</h3>
        <button
          ref={closeButtonRef}
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="shrink-0 mt-0.5 p-0.5 rounded hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* Operator */}
      <p className="text-xs text-foreground mb-2">{facility.operator}</p>

      {/* Status badge */}
      <div className="mb-2">
        <StatusBadge status={facility.status} />
      </div>

      {/* Location */}
      <p className="text-xs text-foreground mb-1">{cityState}</p>

      {/* Capacity */}
      {capacityMw && (
        <div className="text-xs tabular-nums text-foreground mb-1 space-y-0.5">
          {capacityMw.operational !== undefined && (
            <p>{capacityMw.operational} MW operational</p>
          )}
          {capacityMw.planned !== undefined && (
            <p>{capacityMw.planned} MW planned</p>
          )}
        </div>
      )}

      {/* Classification + confidence */}
      <p className="text-xs text-foreground mb-2 capitalize">
        {aiClassification.replace("_", " ")} · {confidence}
      </p>

      {/* Footer links */}
      <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
        <Link
          href={`/facilities/${facility.id}`}
          className="text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          View details →
        </Link>
        <a
          href={firstSource.url}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`${firstSource.label} (opens in new tab)`}
          className="text-xs text-foreground/80 hover:text-foreground flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          <ExternalLink className="size-3" aria-hidden="true" />
          Source
        </a>
      </div>
    </div>
  );
}
