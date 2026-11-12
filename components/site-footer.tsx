import Link from "next/link";

import { siteConfig } from "@/lib/site";
import { getSiteNavGroups } from "@/lib/site-nav";
import { Wordmark } from "@/components/wordmark";

const NAV_LINK_CLASS =
  "inline-flex min-h-11 items-center rounded-sm underline-offset-4 transition-colors motion-reduce:transition-none hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const EXTERNAL_NAV_LINK_CLASS =
  "inline-flex min-h-11 items-center gap-1 rounded-sm underline-offset-4 transition-colors motion-reduce:transition-none hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function SiteFooter() {
  return (
    <footer data-site-footer className="print:hidden relative border-t border-border">
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
              aria-label={`${siteConfig.name}: ${siteConfig.tagline}, home`}
              className="inline-flex flex-col items-start gap-0 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <Wordmark showTagline />
            </Link>
            <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
              A source-cited survey of the U.S. compute buildout —
              data centers, AI campuses, crypto-mining, and the power built to
              feed them — and its civic footprint. Not affiliated with any
              corporation or government agency.
            </p>
            <p className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
              An independent project by Edward Kubiak
            </p>
          </div>

          {/* The same five groups as the mobile sheet (lib/site-nav.ts) */}
          <div className="grid grid-cols-2 gap-8 sm:col-span-2 sm:grid-cols-4 lg:col-span-2">
            {getSiteNavGroups().map((group) => (
              <div key={group.label} className="space-y-2">
                <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                  {group.label}
                </p>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {group.links.map((link) => (
                    <li key={link.href}>
                      {link.external ? (
                        <a
                          href={link.href}
                          target="_blank"
                          rel="noreferrer noopener"
                          aria-label={`${link.label} (opens in new tab)`}
                          className={EXTERNAL_NAV_LINK_CLASS}
                        >
                          {link.label}
                          <span aria-hidden="true">↗</span>
                        </a>
                      ) : (
                        <Link href={link.href} className={NAV_LINK_CLASS}>
                          {link.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <p className="mt-8 text-sm leading-relaxed text-muted-foreground">
          Map data &copy;{" "}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer noopener"
            aria-label="OpenStreetMap copyright and license (opens in new tab)"
            className="underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm"
          >
            OpenStreetMap
          </a>{" "}
          contributors
        </p>

        {/* Margin line */}
        <div className="mt-8 flex flex-col gap-2 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            {siteConfig.name}
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
