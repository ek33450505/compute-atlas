"use client";

import { useSearchParams } from "next/navigation";

/**
 * Thank-you note for the Stripe Payment Link success redirect
 * (`/support?thanks=1`). Reads the query on the client so /support itself
 * stays statically cacheable; renders nothing without `thanks=1`. Wrap in
 * <Suspense> (useSearchParams opts the nearest boundary out of prerendering).
 */
export function SupportThanks() {
  const thanks = useSearchParams().get("thanks");
  if (thanks !== "1") return null;
  return (
    <div
      role="status"
      className="max-w-2xl rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-foreground"
    >
      Thank you. Your support is received and helps cover the database,
      hosting, and discovery pipeline. Your payment confirmation comes from Stripe.
    </div>
  );
}
