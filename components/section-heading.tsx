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
  /**
   * Display step for the `<h2>`. `default` is the site-wide section rank used
   * by every lens and collection page; `lg` is the homepage's louder step,
   * which exists so the home page reads with three display sizes (hero h1 →
   * section h2 → card title) instead of the near-flat two it had.
   *
   * Reserved for the homepage on purpose: a second page adopting `lg` makes
   * the size stop meaning "this is the front door" and start meaning nothing.
   */
  size?: "default" | "lg";
}

/**
 * Only the size step varies — `font-display` and `text-foreground` are
 * constant, so the default branch reproduces the pre-prop className exactly
 * and the 40 existing call sites render byte-for-byte as before.
 */
const H2_SIZE = {
  default: "text-2xl",
  lg: "text-3xl sm:text-4xl",
} as const;

/**
 * The "§ kicker + h2" section-heading pair repeated near-identically across
 * /states/[state], /operators/[operator], /opposition, /power, /crypto,
 * /rankings, and /stats (DRY consolidation audit, 2026-09): a mono-caps
 * kicker label over a display h2. The wrapping `<section aria-labelledby>`
 * stays at call sites — its space-y-* density varies by page — so this
 * component only standardizes the two heading nodes themselves.
 */
export function SectionHeading({
  kicker,
  id,
  title,
  size = "default",
}: SectionHeadingProps) {
  return (
    <>
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        § {kicker}
      </p>
      <h2 id={id} className={`font-display ${H2_SIZE[size]} text-foreground`}>
        {title}
      </h2>
    </>
  );
}
