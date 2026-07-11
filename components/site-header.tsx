import Link from "next/link";
import { Code2 } from "lucide-react";

import { siteConfig } from "@/lib/site";
import { Wordmark } from "@/components/wordmark";
import { MobileNav } from "@/components/mobile-nav";
import { ExploreMenu } from "@/components/explore-menu";

const PRIMARY_LINKS = [
  { label: "Map", href: "/map" },
  { label: "Table", href: "/table" },
  { label: "Stats", href: "/stats" },
] as const;

const EXPLORE_LINKS = [
  { label: "States", href: "/states" },
  { label: "Power", href: "/power" },
  { label: "Opposition", href: "/opposition" },
] as const;

const TRAILING_LINKS = [
  { label: "About", href: "/about" },
] as const;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background/95 backdrop-blur-sm supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 sm:gap-4 px-3 sm:px-6">
        {/* Wordmark */}
        <Link
          href="/"
          aria-label={`${siteConfig.name}, home`}
          className="flex shrink-0 whitespace-nowrap flex-col items-start gap-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
        >
          <Wordmark />
        </Link>

        {/* Primary nav — desktop only; MobileNav handles mobile */}
        <nav aria-label="Primary" className="hidden sm:flex items-center gap-1 ml-2 sm:ml-4">
          {PRIMARY_LINKS.map(({ label, href }) => (
            <Link
              key={href}
              href={href}
              className="flex h-11 items-center px-1.5 sm:px-3 font-mono text-xs uppercase tracking-normal sm:tracking-wider text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              {label}
            </Link>
          ))}
          <ExploreMenu links={EXPLORE_LINKS} />
          {TRAILING_LINKS.map(({ label, href }) => (
            <Link
              key={href}
              href={href}
              className="flex h-11 items-center px-1.5 sm:px-3 font-mono text-xs uppercase tracking-normal sm:tracking-wider text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              {label}
            </Link>
          ))}
        </nav>

        {/* Right-side controls */}
        <div className="ml-auto flex items-center gap-1">
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
          <MobileNav links={[...PRIMARY_LINKS, ...EXPLORE_LINKS, ...TRAILING_LINKS]} />
        </div>
      </div>
    </header>
  );
}
