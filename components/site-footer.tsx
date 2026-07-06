import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-border py-6 text-sm text-muted-foreground">
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-2 px-4 sm:flex-row sm:justify-between sm:px-6">
        <p>
          Open civic data tracker — not affiliated with any corporation or
          government agency.
        </p>
        <div className="flex items-center gap-4">
          <Link
            href="/about"
            className="underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
          >
            Data &amp; methodology
          </Link>
          <span aria-hidden>·</span>
          <span>Map data © OpenStreetMap contributors</span>
        </div>
      </div>
    </footer>
  );
}
