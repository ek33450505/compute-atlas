import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Shared "quiet" text-scale action styling — underlined text-sm treatment
 * for secondary CTAs that shouldn't compete visually with a bordered
 * primary button (facility masthead CTA strip, field-gap prompts,
 * confirm-fact prompts). Carries only the visual treatment; compose with
 * `cn()` at the call site to add layout classes such as
 * `inline-flex items-center min-h-11` for a preserved 44px touch target.
 */
export const QUIET_ACTION_CLASS =
  "text-sm underline underline-offset-4 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
