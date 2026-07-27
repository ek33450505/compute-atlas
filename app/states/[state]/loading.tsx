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
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-12 w-1/2" />
        <Skeleton className="h-5 w-40" />
      </div>

      <div className="border-t border-border" />

      <div className="flex flex-wrap gap-4">
        <Skeleton className="h-14 w-24" />
        <Skeleton className="h-14 w-24" />
        <Skeleton className="h-14 w-24" />
        <Skeleton className="h-14 w-24" />
      </div>

      <div className="space-y-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
      </div>

      <div className="space-y-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
      </div>
    </div>
  );
}
