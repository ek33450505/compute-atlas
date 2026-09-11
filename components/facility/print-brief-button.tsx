"use client";

import { Printer } from "lucide-react";

import { cn, QUIET_ACTION_CLASS } from "@/lib/utils";

function printBrief() {
  window.print();
}

/**
 * Triggers the browser print dialog for the facility page it's rendered on.
 * The printed output itself is handled entirely by the @media print rules in
 * app/globals.css — plain white/black, interactive-only sections hidden via
 * the `print:hidden` variant, cited source URLs expanded inline — this
 * button is just the missing trigger for infrastructure that already exists.
 *
 * Carries `print:hidden` itself so it never appears in the printout it
 * produces. Quiet text-scale styling — this is used only in the compact CTA
 * strip on the facility masthead (app/facilities/[slug]/page.tsx), never
 * standalone, so it doesn't need its own bordered-button treatment.
 */
export function PrintBriefButton() {
  return (
    <button
      type="button"
      className={cn(
        QUIET_ACTION_CLASS,
        "inline-flex items-center gap-1.5 min-h-11 print:hidden"
      )}
      onClick={printBrief}
    >
      <Printer className="size-3.5" aria-hidden="true" /> Print this brief
    </button>
  );
}
