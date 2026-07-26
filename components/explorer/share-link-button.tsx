"use client";

import { Share2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

async function copyShareLink() {
  // Guard for environments without the Clipboard API (older browsers,
  // insecure/non-HTTPS contexts) — fall back to an error toast rather than
  // throwing, since there's no reliable synchronous feature check we can use
  // to disable the button without risking an SSR/hydration mismatch.
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    toast.error("Couldn't copy the link");
    return;
  }
  try {
    await navigator.clipboard.writeText(window.location.href);
    toast.success("Link copied to clipboard");
  } catch {
    toast.error("Couldn't copy the link");
  }
}

/**
 * Copies the current page URL — including all nuqs-synced filter/view query
 * params — to the clipboard, so a filtered explorer view can be shared as a
 * link.
 */
export function ShareLinkButton() {
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label="Copy a shareable link to this view"
      onClick={copyShareLink}
    >
      <Share2 className="size-4" aria-hidden="true" /> Copy link
    </Button>
  );
}
