"use client";

import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface CopyButtonProps {
  /**
   * Returns the text to copy, called at click time rather than passed as a
   * plain string — so a caller whose text can change after mount (e.g.
   * ShareLinkButton reading the live `window.location.href`) always copies
   * the current value, not one captured at render time.
   */
  getText: () => string;
  label: string;
  ariaLabel: string;
  successMessage: string;
  errorMessage: string;
  icon: LucideIcon;
}

/**
 * Generic copy-to-clipboard button: guards for environments without the
 * Clipboard API (older browsers, insecure/non-HTTPS contexts) and falls back
 * to an error toast rather than throwing, since there's no reliable
 * synchronous feature check to disable the button without risking an
 * SSR/hydration mismatch. Reports success via a toast too.
 *
 * Extracted from ShareLinkButton (components/explorer/share-link-button.tsx,
 * now a thin wrapper around this) so a second consumer — the embeddable-map
 * snippet copy control on /states/[state] — doesn't reimplement the same
 * guard/try-catch/toast logic a third time.
 */
export function CopyButton({
  getText,
  label,
  ariaLabel,
  successMessage,
  errorMessage,
  icon: Icon,
}: CopyButtonProps) {
  async function handleCopy() {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      toast.error(errorMessage);
      return;
    }
    try {
      await navigator.clipboard.writeText(getText());
      toast.success(successMessage);
    } catch {
      toast.error(errorMessage);
    }
  }

  return (
    <Button variant="outline" size="sm" aria-label={ariaLabel} onClick={handleCopy}>
      <Icon className="size-4" aria-hidden="true" /> {label}
    </Button>
  );
}
