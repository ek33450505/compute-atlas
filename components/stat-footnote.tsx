import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Markers assigned to noted stats, in render order.
 *
 * Three is not a guess at a future need — it is the point past which a stat
 * row carrying that many asterisked figures has a layout problem rather than
 * a footnote problem. Past the third, the last marker repeats: a repeated
 * glyph is a degraded footnote, where a missing one would be a caption that
 * silently under-reports, which is the exact failure this whole mechanism
 * exists to prevent.
 */
const MARKERS = ["*", "†", "‡"] as const;

export interface StatFootnote {
  marker: string;
  note: string;
}

/**
 * Pairs each stat that carries a `note` with a footnote marker.
 *
 * Caption glyph and footnote glyph come from this one pass, deliberately: the
 * two are rendered by different elements in different parts of the row, and
 * deriving them separately is how a "*" over one tile ends up explained by
 * the footnote belonging to another.
 *
 * Returns a lookup by stat index (not by label — labels repeat) plus the
 * footnotes in the order they should be printed.
 */
export function assignFootnoteMarkers(stats: readonly { note?: string }[]): {
  markerAt: (index: number) => string | undefined;
  footnotes: StatFootnote[];
} {
  const markers = new Map<number, string>();
  const footnotes: StatFootnote[] = [];

  stats.forEach((stat, i) => {
    if (!stat.note) return;
    const marker = MARKERS[Math.min(footnotes.length, MARKERS.length - 1)];
    markers.set(i, marker);
    footnotes.push({ marker, note: stat.note });
  });

  return { markerAt: (index) => markers.get(index), footnotes };
}

/**
 * A stat tile's caption, with its footnote marker when it has one.
 *
 * The label stays a bare text node of the caption element and the marker is
 * its ELEMENT sibling — deliberately, and not merely as the shorter spelling.
 * Wrapping the label in its own `<span>` would push it out of the caption's
 * direct text nodes, and Testing Library matches on exactly those, so every
 * `getByText("States")` in the page tests would stop finding the caption it
 * has always found. A `<sup>` sibling is invisible to that query, so an
 * un-noted tile and a noted tile are both still located the same way.
 *
 * The marker is `aria-hidden`: it is typographic glue pointing at the
 * footnote below, and "States asterisk" is not something a screen reader
 * should say. The footnote's own text is left fully readable.
 */
export function StatLabel({ label, marker }: { label: ReactNode; marker?: string }) {
  return (
    <>
      {label}
      {marker ? (
        <sup aria-hidden="true" className="ml-px">
          {marker}
        </sup>
      ) : null}
    </>
  );
}

/**
 * The footnote line printed under a stat row. Renders nothing when no stat in
 * the row carried a note, so callers can drop it in unconditionally.
 *
 * Sized and cased as running text rather than as a caption: the row's labels
 * are uppercase mono with wide tracking, which is legible at one or two words
 * and unreadable at a sentence.
 */
export function StatFootnotes({
  footnotes,
  className,
}: {
  footnotes: readonly StatFootnote[];
  className?: string;
}) {
  if (footnotes.length === 0) return null;

  return (
    <p
      className={cn(
        "w-full font-mono text-[11px] leading-relaxed text-muted-foreground",
        className
      )}
    >
      {footnotes.map(({ marker, note }, i) => (
        <span key={i} className="mr-6 inline-block">
          <span aria-hidden="true">{marker} </span>
          {note}
        </span>
      ))}
    </p>
  );
}
