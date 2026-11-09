"use client";

import { useEffect } from "react";

/**
 * Moves focus to the element with `targetId` when it mounts. For content that a link just
 * navigated to (WCAG 2.4.3): without it, keyboard focus stays on the activated link while the
 * content it loaded sits elsewhere in the page. The target needs `tabIndex={-1}`. Key the
 * component by whatever identifies the content so a different one remounts it and focuses again.
 */
export function FocusOnMount({ targetId }: { targetId: string }) {
  useEffect(() => {
    document.getElementById(targetId)?.focus();
  }, [targetId]);
  return null;
}
