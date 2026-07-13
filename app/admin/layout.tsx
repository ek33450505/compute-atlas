import Link from "next/link";

import { logout } from "@/app/admin/login/actions";
import { Button } from "@/components/ui/button";

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
          </nav>
        </div>
        <form action={logout}>
          <Button type="submit" variant="outline" size="sm">
            Log out
          </Button>
        </form>
      </header>
      <div className="flex-1 px-6 py-6">{children}</div>
    </div>
  );
}
