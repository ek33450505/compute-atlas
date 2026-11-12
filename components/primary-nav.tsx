"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

interface PrimaryNavProps {
  readonly links: readonly { readonly label: string; readonly href: string }[];
}

export function PrimaryNav({ links }: PrimaryNavProps) {
  const pathname = usePathname();

  return (
    // xl: with nine items the header needs ~1,137px (page scrollWidth at a
    // 1024px viewport, measured 2026-11-11). A shorter nav can return this to lg.
    <nav aria-label="Primary" className="hidden xl:flex items-center gap-1 ml-4">
      {links.map(({ label, href }) => {
        const isActive = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "relative flex h-11 items-center px-3 font-mono text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm",
              "after:absolute after:inset-x-1.5 after:bottom-1.5 after:h-px after:origin-left after:scale-x-0 after:bg-primary after:transition-transform motion-reduce:after:transition-none",
              isActive ? "text-foreground after:scale-x-100" : "hover:after:scale-x-100"
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
