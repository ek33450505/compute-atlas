"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface ExploreMenuProps {
  links: readonly { readonly label: string; readonly href: string }[];
}

export function ExploreMenu({ links }: ExploreMenuProps) {
  const pathname = usePathname();
  const isActive = links.some(
    (l) => pathname === l.href || pathname.startsWith(l.href + "/")
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex h-11 items-center gap-1 px-1.5 sm:px-3 font-mono text-xs uppercase tracking-normal sm:tracking-wider text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm",
          isActive && "text-foreground"
        )}
      >
        Explore
        <ChevronDown className="size-3" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4}>
        {links.map(({ label, href }) => {
          const itemActive =
            pathname === href || pathname.startsWith(href + "/");
          return (
            <DropdownMenuItem
              key={href}
              render={<Link href={href} />}
              aria-current={itemActive ? "page" : undefined}
            >
              {label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
