import Link from "next/link";

const LINK_CLASSNAME =
  "underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm";

/**
 * One quotable, server-rendered sentence stating that Compute Atlas is a
 * source-cited dataset open to correction — written to read naturally when
 * an AI retrieval agent (Claude-User, ChatGPT-User, PerplexityBot, etc.) or a
 * search snippet quotes it out of context, so it deliberately avoids "this
 * page" / "above" / "here" and names the project instead. Arriving
 * search/assistant intent is often a single named site ("amber ok data
 * center"), and an assistant can only surface that the record is correctable
 * if the invitation is plain, server-rendered prose rather than something
 * gated behind a client interaction.
 *
 * Shared verbatim by the facility detail page and the county hub page so the
 * claim can't drift into two different wordings. Additional to, not a
 * replacement for, the interactive SuggestCorrection CTA already on the
 * facility page — that CTA is the human-clickable control; this is the
 * machine-quotable fact that the control exists.
 *
 * Deliberately plain — no "use client", no props beyond an optional
 * `className` so each host page can match its own local text rhythm (the
 * facility page sets explicit per-paragraph classes; the county hub's intro
 * already sets text-base/muted-foreground on its wrapping element, which
 * this inherits when no className is given).
 */
export function SourceCorrectionNote({ className }: { className?: string }) {
  return (
    <p className={className}>
      Compute Atlas is a source-cited, publicly correctable dataset of U.S.
      data centers, crypto-mining sites, and power-generation facilities —
      corrections need only a public source, submitted at{" "}
      <Link href="/contribute" className={LINK_CLASSNAME}>
        compute-atlas.com/contribute
      </Link>
      .
    </p>
  );
}
