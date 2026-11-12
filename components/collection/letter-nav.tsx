import Link from "next/link";

import { LETTERS, letterLabel } from "@/lib/letter-index";

export interface LetterNavProps {
  /** Path the letters link to, e.g. "/operators". */
  basePath: string;
  /** Accessible name for the landmark, e.g. "Operators by first letter". */
  label: string;
  /** Letters that hold at least one entry; the rest render as plain text. */
  available: ReadonlySet<string>;
  /** The letter being shown, if any. */
  current: string | null;
}

const ITEM =
  "inline-flex min-h-8 min-w-8 items-center justify-center rounded-sm border px-2 font-mono text-xs";

/**
 * A–Z jump links. Each available letter is a crawlable `<a href>`; letters
 * with no entries are not links, so nothing leads to an empty page.
 */
export function LetterNav({ basePath, label, available, current }: LetterNavProps) {
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-1.5">
        {LETTERS.map((letter) => {
          const text = letterLabel(letter);
          if (!available.has(letter)) {
            // Full-contrast text (muted-foreground is 6.7:1 on --background; the old
            // /50 fade was 2.24:1 and failed axe), marked by strikethrough + sr-only text.
            return (
              <li key={letter}>
                <span
                  className={`${ITEM} border-transparent text-muted-foreground line-through decoration-muted-foreground/60`}
                >
                  <span>{text}</span>
                  <span className="sr-only"> (no entries)</span>
                </span>
              </li>
            );
          }
          const isCurrent = letter === current;
          return (
            <li key={letter}>
              <Link
                href={`${basePath}?letter=${letter}`}
                aria-current={isCurrent ? "page" : undefined}
                className={`${ITEM} border-border text-foreground transition-colors motion-reduce:transition-none hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${isCurrent ? "bg-muted" : ""}`}
              >
                {text}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
