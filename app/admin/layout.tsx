import type { Metadata } from "next";
import Link from "next/link";
import { ExternalLink } from "lucide-react";

import { logout } from "@/app/admin/login/actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NEON_SYNC_WORKFLOW_URL =
  "https://github.com/ek33450505/compute-atlas/actions/workflows/neon-sync.yml";

// Defense-in-depth: the admin area is cookie-gated, but it must never be
// indexed even if a link to it leaks.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div className="flex items-center gap-6">
          <Link href="/admin/submissions" className="text-sm font-semibold">
            Compute Atlas Admin
          </Link>
          <nav className="flex items-center gap-4">
            <Link
              href="/admin/submissions"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Submissions
            </Link>
            <Link
              href="/admin/leads"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Leads
            </Link>
            <Link
              href="/admin/facilities"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Facilities
            </Link>
            <Link
              href="/admin/contact"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Contact
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={NEON_SYNC_WORKFLOW_URL}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Publish snapshot (opens in new tab)"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
            Publish snapshot
          </a>
          <form action={logout}>
            <Button type="submit" variant="outline" size="sm">
              Log out
            </Button>
          </form>
        </div>
      </header>
      <div className="flex-1 px-6 py-6">{children}</div>
    </div>
  );
}
