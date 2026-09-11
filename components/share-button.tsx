"use client";

import { Share2 } from "lucide-react";
import { toast } from "sonner";
import { cn, QUIET_ACTION_CLASS } from "@/lib/utils";

interface ShareButtonProps {
  title: string;
  url: string;
  text?: string;
  className?: string;
}

/**
 * Progressive-enhancement share control: uses the native Web Share API when
 * the browser exposes it (mobile Safari/Chrome and most share-sheet-capable
 * browsers), and falls back to copying the URL to the clipboard everywhere
 * else. Renders a single button with a single click handler — feature
 * detection happens INSIDE the handler, at click time, never at module or
 * render scope. This is a client component, but Next still renders it once
 * on the server for the initial HTML; a render-time `navigator.share` read
 * would either throw (no `navigator` in the server runtime) or, if guarded,
 * differ server vs. client and split the DOM the two environments produce —
 * a hydration mismatch. Branching inside the handler keeps the rendered
 * button identical everywhere, and the fork only happens in response to a
 * real user click.
 *
 * Compose-vs-duplicate: the clipboard fallback below intentionally mirrors,
 * rather than imports, components/ui/copy-button.tsx's guard (`navigator
 * .clipboard` presence check, try/catch, success/error toast). CopyButton
 * only exports the full component — it always renders its own `<Button>`
 * and doesn't expose the guarded write as a standalone function — so
 * composing it here would mean conditionally rendering a second button tree
 * depending on share support, which is exactly the render-time branch this
 * component avoids for hydration safety (see above). Extracting a shared
 * `copyToClipboard(text, messages)` helper out of copy-button.tsx would let
 * this call into it directly, but that file is out of scope for this change.
 * The block below is kept identical in shape to CopyButton's guard so that
 * future extraction is a pure delete-and-import here.
 */
export function ShareButton({ title, url, text, className }: ShareButtonProps) {
  async function handleShare() {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      const shareData: ShareData = text ? { title, text, url } : { title, url };
      try {
        await navigator.share(shareData);
        return;
      } catch (err) {
        // DOMException (what navigator.share rejects with) does not
        // reliably satisfy `instanceof Error` across environments (same
        // trap documented in scripts/discovery/check-sources.ts for
        // AbortController aborts) — check `.name` directly instead of
        // gating on instanceof first.
        const name = (err as { name?: unknown } | null)?.name;
        if (name === "AbortError") {
          // User dismissed the share sheet — not an error, nothing to report.
          return;
        }
        // Real failure (permission denied, no share target, etc.) — fall
        // through to the clipboard fallback below.
      }
    }

    if (typeof navigator === "undefined" || !navigator.clipboard) {
      toast.error("Couldn't copy the link");
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied to clipboard");
    } catch {
      toast.error("Couldn't copy the link");
    }
  }

  return (
    <button
      type="button"
      aria-label={`Share ${title}`}
      className={cn(
        QUIET_ACTION_CLASS,
        "inline-flex items-center gap-1.5 min-h-11",
        className
      )}
      onClick={handleShare}
    >
      <Share2 className="size-3.5" aria-hidden="true" /> Share
    </button>
  );
}
