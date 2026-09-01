import Link from "next/link";

import { siteConfig } from "@/lib/site";
import { Wordmark } from "@/components/wordmark";

const EXPLORE_LINKS = [
  { label: "States", href: "/states" },
  { label: "By status", href: "/status" },
  { label: "By metro", href: "/metros" },
  { label: "Power", href: "/power" },
  { label: "Opposition", href: "/opposition" },
] as const;

const NAV_LINK_CLASS =
  "inline-flex min-h-11 items-center rounded-sm underline-offset-4 transition-colors motion-reduce:transition-none hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

const EXTERNAL_NAV_LINK_CLASS =
  "inline-flex min-h-11 items-center gap-1 rounded-sm underline-offset-4 transition-colors motion-reduce:transition-none hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export function SiteFooter() {
  return (
    <footer className="print:hidden relative border-t border-border">
      {/* Faint graticule wash — atlas margin texture */}
      <div
        aria-hidden="true"
        className="graticule pointer-events-none absolute inset-0 opacity-30 [mask-image:linear-gradient(to_bottom,transparent,black_60%)]"
      />

      <div data-footer-inner className="relative mx-auto max-w-7xl px-4 py-10 sm:px-6">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {/* Colophon — identity, mission, attribution */}
          <div className="sm:col-span-2 lg:col-span-1 space-y-3">
            <Link
              href="/"
              aria-label={`${siteConfig.name}, home`}
              className="inline-flex flex-col items-start gap-0 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <Wordmark showTagline />
            </Link>
            <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
              An open, source-cited survey of the U.S. compute buildout —
              data centers, AI campuses, crypto-mining, and the power built to
              feed them — and its civic footprint. Not affiliated with any
              corporation or government agency.
            </p>
            <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              An independent project by{" "}
              <a
                href="https://edwardkubiak.com"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
              >
                Edward Kubiak
              </a>
            </p>
          </div>

          {/* Explore — data lenses */}
          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Explore
            </p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {EXPLORE_LINKS.map(({ label, href }) => (
                <li key={href}>
                  <Link href={href} className={NAV_LINK_CLASS}>
                    {label}
                  </Link>
                </li>
              ))}
              <li>
                <Link href="/explore" className={EXTERNAL_NAV_LINK_CLASS}>
                  All lenses <span aria-hidden="true">→</span>
                </Link>
              </li>
            </ul>
          </div>

          {/* Data & project */}
          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Data &amp; project
            </p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li>
                <Link href="/about" className={NAV_LINK_CLASS}>
                  Data &amp; methodology
                </Link>
              </li>
              <li>
                <Link href="/api" className={NAV_LINK_CLASS}>
                  API
                </Link>
              </li>
              <li>
                <Link href="/contact" className={NAV_LINK_CLASS}>
                  Contact
                </Link>
              </li>
              <li>
                <Link
                  href="/contribute"
                  aria-label="Contribute a facility or correction"
                  className={EXTERNAL_NAV_LINK_CLASS}
                >
                  Contribute a facility <span aria-hidden="true">→</span>
                </Link>
              </li>
              <li>
                <Link href="/activity" className={EXTERNAL_NAV_LINK_CLASS}>
                  Recent activity <span aria-hidden="true">→</span>
                </Link>
              </li>
              <li>
                <Link href="/support" className={NAV_LINK_CLASS}>
                  Support the atlas <span aria-hidden="true">→</span>
                </Link>
              </li>
              <li>
                <a
                  href={siteConfig.repoUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label="View source on GitHub (opens in new tab)"
                  className={EXTERNAL_NAV_LINK_CLASS}
                >
                  Source on GitHub
                  <span aria-hidden="true">↗</span>
                </a>
              </li>
              <li className="leading-relaxed">
                Map data &copy;{" "}
                <a
                  href="https://www.openstreetmap.org/copyright"
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label="OpenStreetMap copyright and license (opens in new tab)"
                  className="underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                >
                  OpenStreetMap
                </a>{" "}
                contributors
              </li>
            </ul>
          </div>
        </div>

        {/* Edition margin line */}
        <div className="mt-8 flex flex-col gap-2 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {siteConfig.name} · Edition 2026
          </p>
          <p
            aria-label="Coordinates: 39.5 degrees north, 98.5 degrees west"
            className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
          >
            39.5°N 98.5°W
          </p>
        </div>
      </div>
    </footer>
  );
}
