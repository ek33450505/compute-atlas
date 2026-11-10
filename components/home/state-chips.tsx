import Link from "next/link";

import { stateNameFromCode, stateSlugFromCode } from "@/lib/us-states";

export interface StateChipsProps {
  states: { state: string; count: number }[];
  className?: string;
}

const CHIP_CLASS =
  "inline-flex min-h-11 items-center rounded-md border border-border bg-background/85 px-3 py-2 font-mono text-xs uppercase tracking-wider text-foreground hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Phone-only "Browse by state" row; the caller hides it at sm+. */
export function StateChips({ states, className }: StateChipsProps) {
  const chips = states.flatMap(({ state }) => {
    const slug = stateSlugFromCode(state);
    const name = stateNameFromCode(state);
    return slug && name ? [{ slug, name }] : [];
  });
  if (chips.length === 0) return null;

  return (
    <nav aria-label="Browse by state" className={className}>
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        Browse by state
      </p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {chips.map((c) => (
          <li key={c.slug}>
            <Link href={`/states/${c.slug}`} className={CHIP_CLASS}>
              {c.name}
            </Link>
          </li>
        ))}
        <li>
          <Link href="/states" className={CHIP_CLASS}>
            All states
          </Link>
        </li>
      </ul>
    </nav>
  );
}
