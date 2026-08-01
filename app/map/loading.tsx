import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div
      role="status"
      aria-label="Loading…"
      className="flex overflow-hidden h-[calc(100dvh-4rem)] supports-[height:100svh]:h-[calc(100svh-4rem)] flex-col"
    >
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-12 w-full" />
      <Skeleton className="w-full flex-1" />
    </div>
  );
}
