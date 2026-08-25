import type { ReactNode } from "react";

export interface PageMastheadProps {
  /** Small uppercase kicker above the title (e.g. "By operator"). */
  eyebrow: ReactNode;
  /** The page's h1. */
  title: ReactNode;
  /** Optional standfirst paragraph, wrapped in the shared measure-constrained <p>. */
  dek?: ReactNode;
  /** Anything else that belongs inside the header, after the dek and before the rule. */
  children?: ReactNode;
}

/**
 * The masthead block at the top of a lens or landing page: eyebrow, h1,
 * optional dek, optional extras, closing rule.
 */
export function PageMasthead({ eyebrow, title, dek, children }: PageMastheadProps) {
  return (
    <header className="space-y-4 pb-2">
      <p className="font-mono text-xs uppercase tracking-widest text-primary">
        {eyebrow}
      </p>
      <h1 className="font-display text-4xl leading-[1.05] text-foreground sm:text-5xl">
        {title}
      </h1>
      {dek ? (
        <p className="max-w-2xl text-base text-muted-foreground">{dek}</p>
      ) : null}
      {children}
      <div className="border-t border-border" />
    </header>
  );
}
