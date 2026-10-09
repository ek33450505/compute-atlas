"use client";

import { useId, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { refreshAggregatesAction } from "@/app/admin/submissions/actions";

/**
 * Busts the global `"facilities"` cache tag once, after an approval batch, so
 * aggregate pages stop serving a partial count. See `refreshAggregatesAction`.
 */
export function RefreshTotalsButton() {
  const helpId = useId();
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    startTransition(async () => {
      try {
        await refreshAggregatesAction();
        toast.success("Site totals refreshed — the homepage updates on its second reload.");
      } catch {
        toast.error("Could not refresh site totals. Try again.");
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={isPending}
        aria-describedby={helpId}
      >
        Refresh site totals
      </Button>
      <p id={helpId} className="max-w-xs text-xs text-muted-foreground sm:text-right">
        Run once after approving a batch. The homepage shows the new totals from its second
        reload; other summary pages refresh within the hour regardless.
      </p>
    </div>
  );
}
