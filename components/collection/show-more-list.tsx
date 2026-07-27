"use client";

import { Children, isValidElement, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

export interface ShowMoreListProps {
  /**
   * The full set of already-rendered items (e.g. facility cards). Every item
   * stays mounted in the DOM at all times — collapsed items are hidden via
   * the `hidden` attribute rather than omitted, so the full set stays
   * server-rendered and crawlable for SEO even while visually collapsed.
   */
  children: ReactNode;
  /** Items at or beyond this index are collapsed until "Show more" is clicked. */
  initialCount?: number;
  /** Grid/layout classes applied to the wrapper holding every item. */
  className?: string;
  /** Plural noun appended to the button label, e.g. "facilities" -> "Show 12 more facilities". */
  itemLabel?: string;
}

const DEFAULT_INITIAL_COUNT = 48;

/**
 * Progressive-reveal wrapper for long lists/grids. Renders every child up
 * front — never a fixed-height inner scroll box, which hurts mobile,
 * find-in-page, and a11y — and collapses everything past `initialCount`
 * behind the HTML `hidden` attribute (display:none; removed from layout and
 * the accessibility tree). A single "Show more" button reveals the rest.
 *
 * Each item is wrapped in a `display:contents` div while visible, so the
 * wrapper never participates in the parent grid's own box layout (the real
 * child — e.g. a card `<Link>`— remains the effective grid item, preserving
 * whatever row-stretch/sizing the grid class on `className` establishes).
 * The wrapper only becomes a real box (via the `hidden` attribute) when
 * collapsed, which is exactly when we want it removed from grid flow.
 *
 * Without JS, the overflow stays collapsed (progressive enhancement) but
 * remains present in the DOM for crawlers — the standard SSR tradeoff.
 */
export function ShowMoreList({
  children,
  initialCount = DEFAULT_INITIAL_COUNT,
  className,
  itemLabel,
}: ShowMoreListProps) {
  const [expanded, setExpanded] = useState(false);
  const items = Children.toArray(children);
  const hiddenCount = Math.max(items.length - initialCount, 0);

  return (
    <>
      <div className={className}>
        {items.map((item, index) => {
          const isCollapsed = !expanded && index >= initialCount;
          const key = isValidElement(item) ? (item.key ?? index) : index;
          return (
            <div
              key={key}
              hidden={isCollapsed}
              className={isCollapsed ? undefined : "contents"}
            >
              {item}
            </div>
          );
        })}
      </div>

      {hiddenCount > 0 && !expanded && (
        <div className="mt-6 flex justify-center">
          <Button
            type="button"
            variant="outline"
            aria-expanded={expanded}
            onClick={() => setExpanded(true)}
          >
            Show {hiddenCount} more{itemLabel ? ` ${itemLabel}` : ""}
          </Button>
        </div>
      )}
    </>
  );
}
