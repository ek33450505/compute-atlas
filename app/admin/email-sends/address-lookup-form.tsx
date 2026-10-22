"use client";

import { useActionState, useId } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { lookupEmailSendsAction } from "@/app/admin/email-sends/actions";
import { EmailSendsTable } from "@/app/admin/email-sends/email-sends-table";
import { INITIAL_LOOKUP_STATE } from "@/app/admin/email-sends/lookup-state";

/**
 * Looks up the sends for one address. The input is uncontrolled and has no
 * default value, so the address is neither echoed back nor kept in state; it
 * goes to the server as a POST body, never a URL.
 */
export function AddressLookupForm() {
  const inputId = useId();
  const [state, formAction, isPending] = useActionState(lookupEmailSendsAction, INITIAL_LOOKUP_STATE);

  return (
    <section aria-labelledby={`${inputId}-heading`} className="flex flex-col gap-3">
      <h2 id={`${inputId}-heading`} className="text-base font-semibold">
        Look up an address
      </h2>
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={inputId}>Email address</Label>
          <Input
            id={inputId}
            name="address"
            type="text"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            className="w-72 focus-visible:ring-2"
          />
        </div>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Looking up…" : "Look up"}
        </Button>
      </form>
      {/* Always mounted so the first result is announced; empty until there is a message. */}
      <p role="status" className="min-h-5 text-sm text-muted-foreground">
        {state.message}
      </p>
      {state.rows.length > 0 ? (
        <EmailSendsTable rows={state.rows} caption="Sends for the looked-up address" />
      ) : null}
    </section>
  );
}
