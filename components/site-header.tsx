import Link from "next/link";
import { Code2 } from "lucide-react";

import { siteConfig } from "@/lib/site";
import { buildSearchIndex } from "@/lib/search-index";
import { Wordmark } from "@/components/wordmark";
import { PrimaryNav } from "@/components/primary-nav";
import { MobileNav } from "@/components/mobile-nav";
import { CommandPalette } from "@/components/search/command-palette";

const NAV_LINKS = [
  { label: "Map", href: "/map" },
  { label: "Table", href: "/table" },
  { label: "Stats", href: "/stats" },
  { label: "Explore", href: "/explore" },
  { label: "Activity", href: "/activity" },
  { label: "About", href: "/about" },
] as const;

const MOBILE_NAV_GROUPS = [
  {
    label: "Tools",
    links: [
      { label: "Map", href: "/map" },
      { label: "Table", href: "/table" },
      { label: "Stats", href: "/stats" },
    ],
  },
  {
    label: "Explore",
    links: [
      { label: "Explore all lenses", href: "/explore" },
      { label: "Opposition", href: "/opposition" },
    ],
  },
  {
    label: "Project",
    links: [
      { label: "Activity", href: "/activity" },
      { label: "About", href: "/about" },
      { label: "Contribute", href: "/contribute" },
      { label: "Source on GitHub", href: siteConfig.repoUrl, external: true },
    ],
  },
] as const;

export async function SiteHeader() {
  const searchIndex = await buildSearchIndex();

  return (
    <header className="print:hidden sticky top-0 z-40 w-full border-b border-border bg-background/95 backdrop-blur-sm supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 sm:gap-4 px-3 sm:px-6">
        {/* Wordmark */}
        <Link
          href="/"
          aria-label={`${siteConfig.name}, home`}
          className="flex shrink-0 whitespace-nowrap flex-col items-start gap-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
        >
          <Wordmark showTagline />
        </Link>

        {/* Primary nav — desktop only; MobileNav handles mobile */}
        <PrimaryNav links={NAV_LINKS} />

        {/* Right-side controls */}
        <div className="ml-auto flex items-center gap-1">
          <CommandPalette index={searchIndex} navLinks={NAV_LINKS} />
          {/* GitHub icon — desktop only */}
          <a
            href={siteConfig.repoUrl}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="View source on GitHub"
            className="hidden sm:flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Code2 aria-hidden className="size-4" />
          </a>
          {/* Mobile menu — hidden on sm+ */}
          <MobileNav groups={MOBILE_NAV_GROUPS} />
        </div>
      </div>
    </header>
  );
}
