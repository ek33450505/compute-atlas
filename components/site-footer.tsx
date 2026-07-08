import Link from "next/link";

import { siteConfig } from "@/lib/site";

const FOOTER_NAV = [
  { label: "Map", href: "/map" },
  { label: "Table", href: "/table" },
  { label: "Statistics", href: "/stats" },
  { label: "About & method", href: "/about" },
] as const;

export function SiteFooter() {
  return (
    <footer className="relative border-t border-border">
      {/* Faint graticule wash — atlas margin texture */}
      <div
        aria-hidden="true"
        className="graticule pointer-events-none absolute inset-0 opacity-30 [mask-image:linear-gradient(to_bottom,transparent,black_60%)]"
      />

      <div data-footer-inner className="relative mx-auto max-w-7xl px-4 py-10 sm:px-6">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-[1.6fr_1fr_1fr]">
          {/* Colophon — identity, mission, attribution */}
          <div className="space-y-3">
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="text-base leading-none text-primary"
              >
                ⌖
              </span>
              <span className="font-display text-lg font-semibold leading-none tracking-tight text-foreground">
                {siteConfig.name}
              </span>
            </div>
            <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
              An open, source-verified survey of U.S. AI-datacenter
              infrastructure and its civic impacts. Not affiliated with any
              corporation or government agency.
            </p>
            <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              An independent project by Edward Kubiak
            </p>
            <div className="flex flex-col items-start gap-1">
              <a href={`${siteConfig.repoUrl}/issues/new/choose`} target="_blank" rel="noreferrer noopener"
                 aria-label="Contribute a correction or new facility on GitHub (opens in new tab)"
                 className="inline-flex min-h-11 items-center gap-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm">
                Contribute a correction <span aria-hidden="true">↗</span>
              </a>
              <a href={siteConfig.sponsorUrl} target="_blank" rel="noreferrer noopener"
                 aria-label="Sponsor Compute Atlas on GitHub Sponsors (opens in new tab)"
                 className="inline-flex min-h-11 items-center gap-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm">
                Sponsor this project <span aria-hidden="true">↗</span>
              </a>
            </div>
          </div>

          {/* Navigate */}
          <nav aria-label="Footer" className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Navigate
            </p>
            <ul>
              {FOOTER_NAV.map(({ label, href }) => (
                <li key={href}>
                  <Link
                    href={href}
                    className="inline-flex min-h-11 items-center rounded-sm font-mono text-sm uppercase tracking-wider text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* Sources & license */}
          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Sources &amp; license
            </p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li>
                <Link
                  href="/about"
                  className="inline-flex min-h-11 items-center rounded-sm underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  Data &amp; methodology
                </Link>
              </li>
              <li className="leading-relaxed">
                Map data &copy;{" "}
                <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer noopener"
                   aria-label="OpenStreetMap copyright and license (opens in new tab)"
                   className="underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm">OpenStreetMap</a>{" "}
                contributors
              </li>
              <li>
                <a
                  href={siteConfig.repoUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label="View source on GitHub (opens in new tab)"
                  className="inline-flex min-h-11 items-center gap-1 rounded-sm underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  Source on GitHub
                  <span aria-hidden="true">↗</span>
                </a>
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
