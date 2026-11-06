"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Copy } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";

type CiteThisFacilityProps = {
  /** Facility display name, quoted in the citation. */
  name: string;
  /** Canonical record URL — pass the one the page already computed for JSON-LD. */
  url: string;
};

const LINK_CLASS =
  "underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm";

/**
 * YYYY-MM-DD in the reader's own timezone (same approach as
 * print-provenance-footer.tsx): `toISOString()` would be the UTC date, a
 * different day from about 8pm onward in the Americas.
 */
function localIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const LICENCE = "CC BY 4.0";

/** The plain citation string: what is displayed and what is copied. */
function citationText(name: string, url: string, date: string): string {
  return `\u201C${name}\u201D, Compute Atlas, ${url}, accessed ${date}. Licensed under ${LICENCE}.`;
}

/**
 * Visible "Cite this facility" block, in the format /data defines.
 *
 * The access date is filled CLIENT-SIDE: facility pages are ISR-cached for
 * 24h, so a server-rendered date would be the cache date, not the reader's.
 * Until the effect runs (SSR, no JS) the literal `[date]` renders, so the
 * server and first client render match. The date is re-stamped on `focus` and
 * `visibilitychange`, so a tab left open overnight updates what is shown and
 * what the copy button copies: both come from `citationText` with the same
 * `accessed` value, so the copied string always equals the displayed one.
 */
export function CiteThisFacility({ name, url }: CiteThisFacilityProps) {
  const [accessed, setAccessed] = useState<string | null>(null);

  useEffect(() => {
    const stamp = () => setAccessed(localIsoDate(new Date()));
    stamp();
    window.addEventListener("focus", stamp);
    document.addEventListener("visibilitychange", stamp);
    return () => {
      window.removeEventListener("focus", stamp);
      document.removeEventListener("visibilitychange", stamp);
    };
  }, []);

  // The licence is rendered as a link, so display everything before it.
  const lead = citationText(name, url, accessed ?? "[date]").slice(0, -`${LICENCE}.`.length);

  return (
    <section aria-labelledby="cite-heading-facility" className="print:hidden space-y-3">
      <h2 id="cite-heading-facility" className="font-display text-xl text-foreground">
        Cite this facility
      </h2>
      <p className="font-mono text-sm leading-relaxed break-words text-foreground">
        {lead}
        <a
          href="https://creativecommons.org/licenses/by/4.0/"
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`${LICENCE} (opens in new tab)`}
          className={LINK_CLASS}
        >
          {LICENCE}
        </a>
        .
      </p>
      <CopyButton
        getText={() => citationText(name, url, accessed ?? localIsoDate(new Date()))}
        label="Copy citation"
        ariaLabel="Copy citation"
        successMessage="Citation copied"
        errorMessage="Couldn't copy the citation"
        icon={Copy}
      />
      <p className="text-sm text-muted-foreground">
        Each record lists its own public sources. Cite those directly when a claim depends on
        them.{" "}
        <Link href="/data#cite-heading" className={LINK_CLASS}>
          How to cite
        </Link>
      </p>
    </section>
  );
}
