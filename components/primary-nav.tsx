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
    <nav aria-label="Primary" className="hidden sm:flex items-center gap-1 ml-2 lg:ml-4">
      {links.map(({ label, href }) => {
        const isActive = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "relative flex h-11 items-center px-1.5 lg:px-3 font-mono text-xs uppercase tracking-normal lg:tracking-wider text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm",
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
