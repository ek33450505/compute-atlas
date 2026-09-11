"use client";

import { Printer } from "lucide-react";

import { Button } from "@/components/ui/button";

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
 * produces.
 */
export function PrintBriefButton() {
  return (
    <Button
      type="button"
      variant="outline"
      className="min-h-11 print:hidden"
      onClick={printBrief}
    >
      <Printer className="size-4" aria-hidden="true" /> Print this brief
    </Button>
  );
}
