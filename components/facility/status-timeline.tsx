import { ExternalLink } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { safeExternalHref } from "@/lib/url";
import type { StatusEvent, Source } from "@/lib/schema";

interface StatusTimelineProps {
  history: StatusEvent[];
  sources: Source[];
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
export function StatusTimeline({ history, sources }: StatusTimelineProps) {
  if (history.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No recorded status history yet.
      </p>
    );
  }

  return (
    <ol className="space-y-6 border-l border-border pl-6" aria-label="Status history">
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

              {event.note && (
                <p className="text-sm text-muted-foreground">{event.note}</p>
              )}

              {source && (
                <a
                  href={safeExternalHref(source.url)}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={`${source.label} (opens in new tab)`}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                >
                  <ExternalLink className="size-3" aria-hidden="true" />
                  {source.label}
                </a>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
