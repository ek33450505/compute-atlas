"use client";

import { Share2 } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";

/**
 * Copies the current page URL — including all nuqs-synced filter/view query
 * params — to the clipboard, so a filtered explorer view can be shared as a
 * link. Thin wrapper around the generic clipboard-copy button
 * (components/ui/copy-button.tsx) — see that file for the guard/fallback
 * logic this used to own directly.
 */
export function ShareLinkButton() {
  return (
    <CopyButton
      getText={() => window.location.href}
      label="Copy link"
      ariaLabel="Copy a shareable link to this view"
      successMessage="Link copied to clipboard"
      errorMessage="Couldn't copy the link"
      icon={Share2}
    />
  );
}
