import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div
      role="status"
      aria-label="Loading…"
      className="mx-auto max-w-4xl space-y-10 px-4 py-8 sm:px-6 sm:py-12"
    >
      <span className="sr-only">Loading…</span>

      <div className="space-y-3">
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-10 w-3/4" />
        <Skeleton className="h-5 w-1/2" />
      </div>

      <div className="border-t border-border" />

      <div className="space-y-4">
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>

      <Skeleton className="h-64 w-full rounded-lg" />
    </div>
  );
}
