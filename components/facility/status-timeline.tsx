import { StatusBadge } from "@/components/status-badge";
import { SourceAnchor } from "@/components/facility/fact-row";
import type { StatusEvent, Source } from "@/lib/schema";
import { cn } from "@/lib/utils";

interface StatusTimelineProps {
  history: StatusEvent[];
  sources: Source[];
  /**
   * Tightens the timeline for a teaser context (the homepage record specimen):
   * closer event spacing, and per-event `note` prose omitted. The note is
   * DROPPED rather than truncated — a half-sentence of sourced prose ending in
   * an ellipsis misstates the note it came from, and the full record is one
   * click away. Defaults false, so the facility page's call site is unchanged.
   */
  compact?: boolean;
}

/**
 * Renders a chronological status timeline as a semantic <ol>.
 *
 * Accessibility contract:
 * - Real <ol>/<li> list — screen-reader navigable
 * - Source links include "opens in new tab" in aria-label
 * - Status conveyed by icon + label, never color alone
 * - Empty state is a visible, neutral text message (not an empty list)
 */
export function StatusTimeline({ history, sources, compact = false }: StatusTimelineProps) {
  if (history.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No recorded status history yet.
      </p>
    );
  }

  return (
    // `pl-6` is fixed in both modes: the connector dot below is positioned at
    // `-left-[1.5625rem]`, which is measured against exactly that padding.
    <ol
      className={cn(
        "border-l border-border pl-6",
        compact ? "space-y-3" : "space-y-6"
      )}
      aria-label="Status history"
    >
      {history.map((event, i) => {
        const source =
          event.sourceIndex !== undefined && event.sourceIndex < sources.length
            ? sources[event.sourceIndex]
            : null;

        return (
          <li key={i} className="relative">
            {/* Connector dot — decorative */}
            <span
              className="absolute -left-[1.5625rem] top-[0.375rem] size-2.5 rounded-full border-2 border-border bg-background"
              aria-hidden="true"
            />

            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={event.status} />
                <time
                  dateTime={event.date}
                  className="text-sm text-muted-foreground tabular-nums"
                >
                  {event.date}
                </time>
              </div>

              {!compact && event.note && (
                <p className="text-sm text-muted-foreground">{event.note}</p>
              )}

              {source && <SourceAnchor source={source} />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
