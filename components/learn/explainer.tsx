import Link from "next/link";
import { ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { GlossaryEvidence, GlossaryExplainer } from "@/lib/glossary";
import type { Facility } from "@/lib/schema";
import { formatLocation } from "@/lib/format";
import { COMMUNITY_RECEPTION_META } from "@/lib/community";
import { safeExternalHref } from "@/lib/url";

interface ExplainerProps {
  explainer: GlossaryExplainer;
  /** Resolved facilities keyed by id, for the sections' `exemplarIds`. */
  exemplars: Map<string, Facility>;
}

/** Visible evidence-strength labels — text only, never color-coded. */
const EVIDENCE_LABELS: Record<GlossaryEvidence, string> = {
  substantiated: "Documented in the cited review",
  raised: "Raised by residents",
  "raised-not-substantiated": "Raised by residents · not substantiated by the cited review",
};

/**
 * Renders a cited, editor-approved prose explainer on a /learn/[topic] page:
 * a lede, per-section body copy with an evidence label and exemplar
 * facilities, and a final sources list. Server component (no client state).
 *
 * Mirrors this page's own visual language (font-display headings, `§`
 * eyebrow markers, border-t/pt-10 section rhythm — see app/learn/[topic]/
 * page.tsx's breakdown section) and components/facility/provenance-panel.tsx's
 * accessibility contract for source links.
 *
 * Accessibility contract:
 * - Every section is aria-labelledby its own visible <h2> (logical order:
 *   page h1 -> these h2s)
 * - Evidence strength and community reception are always visible text, never
 *   color-only
 * - Every external source link carries "(opens in new tab)" in its aria-label
 * - Exemplar quotes render in a semantic <blockquote>
 */
export function Explainer({ explainer, exemplars }: ExplainerProps) {
  return (
    <div className="space-y-10">
      <p className="max-w-2xl text-base leading-relaxed text-muted-foreground">
        {explainer.lede}
      </p>

      {explainer.sections.map((section, i) => {
        const headingId = `explainer-section-${i}-heading`;
        const sectionExemplars = (section.exemplarIds ?? [])
          .map((id) => exemplars.get(id))
          .filter((f): f is Facility => f !== undefined);

        return (
          <section
            key={headingId}
            aria-labelledby={headingId}
            className="space-y-6 border-t border-border pt-10"
          >
            <p
              aria-hidden="true"
              className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
            >
              § {section.heading}
            </p>
            <h2 id={headingId} className="font-display text-2xl text-foreground">
              {section.heading}
            </h2>

            <div className="max-w-2xl space-y-4">
              {section.body.map((paragraph, pi) => (
                <p key={pi} className="text-base leading-relaxed text-muted-foreground">
                  {paragraph}
                </p>
              ))}
              {section.evidence && (
                <p className="text-sm font-medium text-foreground">
                  {EVIDENCE_LABELS[section.evidence]}
                </p>
              )}
            </div>

            {sectionExemplars.length > 0 && (
              <ul className="space-y-4" aria-label={`Facilities in the record: ${section.heading}`}>
                {sectionExemplars.map((facility) => {
                  const receptionLabel = facility.community?.status
                    ? COMMUNITY_RECEPTION_META[facility.community.status].label
                    : undefined;

                  return (
                    <li key={facility.id} className="space-y-1.5 border-l-2 border-border pl-4">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <Link
                          href={`/facilities/${facility.id}`}
                          className="text-sm font-medium text-foreground underline underline-offset-2 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                        >
                          {facility.name}
                        </Link>
                        <span className="text-xs text-muted-foreground">
                          {formatLocation(facility)}
                        </span>
                        {receptionLabel && (
                          <Badge variant="outline" className="text-xs">
                            {receptionLabel}
                          </Badge>
                        )}
                      </div>
                      {facility.community?.notes && (
                        <blockquote className="border-l-2 border-border pl-3 text-sm italic text-muted-foreground">
                          {facility.community.notes}
                        </blockquote>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}

      <section
        aria-labelledby="explainer-sources-heading"
        className="space-y-6 border-t border-border pt-10"
      >
        <p
          aria-hidden="true"
          className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground"
        >
          § Sources
        </p>
        <h2 id="explainer-sources-heading" className="font-display text-2xl text-foreground">
          Sources
        </h2>
        <ul className="space-y-4" aria-label="Sources">
          {explainer.sources.map((source) => (
            <li key={source.id} className="space-y-1">
              <a
                href={safeExternalHref(source.url)}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`${source.label} (opens in new tab)`}
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
              >
                <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                {source.label}
              </a>
              <div className="text-xs text-muted-foreground">{source.publisher}</div>
              {source.note && (
                <div className="text-xs text-muted-foreground">{source.note}</div>
              )}
              <div className="text-xs text-muted-foreground">
                Quote located in the served document on {source.verifiedAt}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
