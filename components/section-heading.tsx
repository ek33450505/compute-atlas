import type { ReactNode } from "react";

export interface SectionHeadingProps {
  /**
   * Kicker text WITHOUT the "§ " prefix — this component prepends the glyph
   * and space itself so call sites can't drift on it.
   */
  kicker: ReactNode;
  /**
   * Shared id rendered on the `<h2>`. Must match the wrapping `<section>`'s
   * `aria-labelledby` for the a11y contract to hold — that pairing stays the
   * caller's responsibility since the `<section>` itself is not part of this
   * component.
   */
  id: string;
  /** The heading's visible text. */
  title: ReactNode;
}

/**
 * The "§ kicker + h2" section-heading pair repeated near-identically across
 * /states/[state], /operators/[operator], /opposition, /power, /crypto,
 * /rankings, and /stats (DRY consolidation audit, 2026-09): a mono-caps
 * kicker label over a display h2. The wrapping `<section aria-labelledby>`
 * stays at call sites — its space-y-* density varies by page — so this
 * component only standardizes the two heading nodes themselves.
 */
export function SectionHeading({ kicker, id, title }: SectionHeadingProps) {
  return (
    <>
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        § {kicker}
      </p>
      <h2 id={id} className="font-display text-2xl text-foreground">
        {title}
      </h2>
    </>
  );
}
