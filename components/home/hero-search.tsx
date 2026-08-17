"use client";

import { Search } from "lucide-react";

import { cn } from "@/lib/utils";

export interface HeroSearchProps {
  facilityCount: number;
  className?: string;
}

/**
 * Gazetteer-style search affordance for the hero — reads as a ruled atlas
 * index line, not a SaaS search bar. Renders as a real <button>, not an
 * <input>: it only opens the existing ⌘K command palette (rendered
 * separately in SiteHeader, a different subtree), so a button is the honest
 * semantic here and avoids duplicating search/query state in two places.
 *
 * Dispatches a DOM CustomEvent that CommandPalette listens for — see
 * components/search/command-palette.tsx for why an event and not React
 * context. The ⌘K hint is intentionally static (no platform detection): the
 * palette itself already handles Ctrl/Cmd on the real keydown.
 */
export function HeroSearch({ facilityCount, className }: HeroSearchProps) {
  const label = `Search ${facilityCount.toLocaleString("en-US")} sites, operators, and states`;

  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(new CustomEvent("compute-atlas:open-search"));
      }}
      aria-label={`${label} — opens a search dialog`}
      className={cn(
        "group flex min-h-11 w-full items-center gap-2 rounded-sm border border-border bg-card px-4 text-left transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className
      )}
    >
      <Search
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground transition-colors motion-reduce:transition-none group-hover:text-foreground"
      />
      <span className="flex-1 truncate font-mono text-sm text-muted-foreground transition-colors motion-reduce:transition-none group-hover:text-foreground">
        {label}
      </span>
      <kbd className="hidden shrink-0 items-center rounded-sm border border-border px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground sm:flex">
        ⌘K
      </kbd>
    </button>
  );
}
