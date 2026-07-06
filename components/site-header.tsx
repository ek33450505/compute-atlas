import Link from "next/link";
import { Code2 } from "lucide-react";

import { siteConfig } from "@/lib/site";

const NAV_LINKS = [
  { label: "Map", href: "/" },
  { label: "Table", href: "/table" },
  { label: "About", href: "/about" },
] as const;

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background/95 backdrop-blur-sm supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
        {/* Wordmark */}
        <Link
          href="/"
          className="flex flex-col items-start gap-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
        >
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="text-primary text-base leading-none">⌖</span>
            <span className="font-display text-xl font-semibold tracking-tight text-foreground leading-none">
              {siteConfig.name}
            </span>
          </span>
          <span className="hidden sm:block font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground leading-tight mt-0.5">
            A survey of U.S. AI-datacenter infrastructure
          </span>
        </Link>

        {/* Primary nav */}
        <nav aria-label="Primary" className="flex items-center gap-1 ml-4">
          {NAV_LINKS.map(({ label, href }) => (
            <Link
              key={href}
              href={href}
              className="flex h-11 items-center px-3 font-mono text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              {label}
            </Link>
          ))}
        </nav>

        {/* Right-side controls */}
        <div className="ml-auto flex items-center gap-1">
          <a
            href={siteConfig.repoUrl}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="View source on GitHub"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Code2 aria-hidden className="size-4" />
          </a>
        </div>
      </div>
    </header>
  );
}
