import Link from "next/link";
import { Code2 } from "lucide-react";

import { getPaletteLinks, getSiteNavGroups, NAV_LINKS } from "@/lib/site-nav";
import { siteConfig } from "@/lib/site";
import { Wordmark } from "@/components/wordmark";
import { PrimaryNav } from "@/components/primary-nav";
import { MobileNav } from "@/components/mobile-nav";
import { CommandPalette } from "@/components/search/command-palette";

export function SiteHeader() {
  // The palette loads its operator/state index lazily from /api/nav-index and
  // facilities from /api/search, so no search data rides in any route's RSC
  // payload.
  return (
    <header className="print:hidden sticky top-0 z-40 w-full border-b border-border bg-background/95 backdrop-blur-sm supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-16 items-center gap-2 sm:gap-4 px-3 sm:px-6">
        {/* Wordmark */}
        <Link
          href="/"
          aria-label={`${siteConfig.name}: ${siteConfig.tagline}, home`}
          className="flex shrink-0 whitespace-nowrap flex-col items-start gap-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm"
        >
          <Wordmark showTagline />
        </Link>

        {/* Primary nav — desktop only; MobileNav handles mobile */}
        <PrimaryNav links={NAV_LINKS} />

        {/* Right-side controls */}
        <div className="ml-auto flex items-center gap-1">
          <CommandPalette navLinks={getPaletteLinks()} />
          {/* GitHub icon — desktop only */}
          <a
            href={siteConfig.repoUrl}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="View source on GitHub"
            className="hidden lg:flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <Code2 aria-hidden className="size-4" />
          </a>
          {/* Mobile menu — hidden on lg+ */}
          <MobileNav groups={getSiteNavGroups()} />
        </div>
      </div>
    </header>
  );
}
