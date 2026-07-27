import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div
      role="status"
      aria-label="Loading…"
      className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-12"
    >
      <span className="sr-only">Loading…</span>

      <Skeleton className="h-9 w-64" />
      <Skeleton className="mt-6 h-10 w-full" />
      <Skeleton className="mt-4 h-4 w-48" />

      <div className="mt-4 space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
