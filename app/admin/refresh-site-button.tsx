"use client";

import { useActionState, useRef } from "react";
import { RefreshCw } from "lucide-react";

import { refreshSiteAction, type RefreshSiteState } from "@/app/admin/refresh-site-action";
import { Button } from "@/components/ui/button";

export function RefreshSiteButton() {
  // Claimed synchronously at dispatch: `pending` is a render-time value, so two
  // activations before the pending commit would both read it as false, and
  // useActionState queues a second dispatch rather than dropping it. Released in
  // the reducer's `finally`, so a fast or failing action can never leave the
  // button stuck.
  const inFlight = useRef(false);
  const [state, formAction, pending] = useActionState<RefreshSiteState, FormData>(
    async () => {
      try {
        return await refreshSiteAction();
      } catch {
        // useActionState rethrows to the nearest error boundary, which would
        // take down the admin layout; surface the fixed failure state instead.
        return { ok: false, error: "Refresh failed" };
      } finally {
        inFlight.current = false;
      }
    },
    null
  );

  return (
    // aria-disabled (not disabled) keeps keyboard focus on the button while
    // pending; re-activation is ignored here instead.
    <form
      action={(formData) => {
        if (inFlight.current) return;
        inFlight.current = true;
        formAction(formData);
      }}
      className="flex items-center gap-2"
    >
      <Button
        type="submit"
        variant="outline"
        size="sm"
        aria-disabled={pending}
        aria-busy={pending}
        className="aria-disabled:cursor-wait aria-disabled:opacity-50"
      >
        <RefreshCw
          className={pending ? "size-3.5 animate-spin motion-reduce:animate-none" : "size-3.5"}
          aria-hidden="true"
        />
        Refresh site
      </Button>
      <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
        {pending ? "Refreshing…" : state === null ? "" : state.ok ? "Site refresh requested" : "Refresh failed"}
      </span>
    </form>
  );
}
