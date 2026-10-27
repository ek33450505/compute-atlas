"use client";

import { useState } from "react";
import { Check } from "lucide-react";

interface CommunityFilterProps {
  total: number;
  communityCount: number;
  /** The server-rendered `ActivityList`; its items carry `data-community`. */
  children: React.ReactNode;
}

/**
 * Client toggle over the server-rendered activity list. It flips one data
 * attribute on its container; a CSS rule removes non-community items
 * (`display: none`, so they leave the accessibility tree too). State is local
 * on purpose: a `searchParams` filter would make the ISR `/activity` page
 * dynamic and mint crawlable URL variants. No toggle renders when there are no
 * community entries.
 */
export function CommunityFilter({ total, communityCount, children }: CommunityFilterProps) {
  const [communityOnly, setCommunityOnly] = useState(false);

  if (communityCount === 0) return <>{children}</>;

  const shown = communityOnly ? communityCount : total;

  return (
    <div
      data-community-only={communityOnly ? "true" : "false"}
      className={[
        "data-[community-only=true]:[&_li[data-community=false]]:hidden",
        // The list's `divide-y` puts a bottom border on every non-last <li>,
        // hidden ones included, so a trailing hidden item leaves a stray rule.
        // Filtered: drop those and draw a top rule between visible items only.
        "data-[community-only=true]:[&_li]:border-b-0",
        "data-[community-only=true]:[&_li[data-community=true]~li[data-community=true]]:border-t",
      ].join(" ")}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <button
          type="button"
          aria-pressed={communityOnly}
          onClick={() => setCommunityOnly((v) => !v)}
          className={[
            "inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1.5",
            "font-mono text-xs uppercase tracking-wider cursor-pointer transition-colors",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            communityOnly
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-popover text-foreground hover:border-primary",
          ].join(" ")}
        >
          {/* Non-colour cue for the pressed state (forced colors drop the fill);
              always laid out so the button does not change width. */}
          <Check
            aria-hidden="true"
            className={communityOnly ? "h-3.5 w-3.5" : "invisible h-3.5 w-3.5"}
          />
          Community submissions only
        </button>
        <p
          role="status"
          aria-live="polite"
          className="min-h-[1.25rem] font-mono text-xs text-muted-foreground"
        >
          Showing {shown} of {total} {total === 1 ? "update" : "updates"}
        </p>
      </div>
      {children}
    </div>
  );
}
