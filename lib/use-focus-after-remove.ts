"use client";

import { useLayoutEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Focus restoration for index-keyed array editors (§1f a11y fix).
//
// Shared by facility-sources-section.tsx, facility-status-history-section.tsx,
// and facility-subsidies-section.tsx — all three use the same plain
// index-based array + "Remove" button per row pattern. Removing a row
// unmounts its Remove button; without intervention, focus falls back to
// `<body>` (a WCAG 2.4.3 focus-order / keyboard-trap-adjacent defect).
//
// Contract:
//   - Call `registerRemoveButton(index)` as the `ref` prop on each row's
//     Remove button.
//   - Call `registerAddButton` as the `ref` prop on the section's "Add …"
//     button.
//   - After calling the parent's `onChange` inside `removeRow(index)`, call
//     `focusAfterRemove(index, newLength)` with the array's length *after*
//     the removal.
//   - On the next paint (`useLayoutEffect`, so before the browser reflects
//     the frame to the user), focus moves to:
//       - the Remove button of the row now at
//         `min(removedIndex, newLength - 1)`, if any rows remain; or
//       - the "Add …" button, if the array is now empty.
//
// Buttons are re-registered on every render (index-keyed rows churn their
// DOM nodes on reorder/add/remove), so the ref maps always reflect the
// *current* render's row set by the time the effect runs.
// ---------------------------------------------------------------------------

export function useFocusAfterRemove() {
  const removeButtonRefs = useRef(new Map<number, HTMLButtonElement>());
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocusIndex = useRef<number | null>(null);

  function registerRemoveButton(index: number) {
    return (el: HTMLButtonElement | null) => {
      if (el) {
        removeButtonRefs.current.set(index, el);
      } else {
        removeButtonRefs.current.delete(index);
      }
    };
  }

  function registerAddButton(el: HTMLButtonElement | null) {
    addButtonRef.current = el;
  }

  /** Call after `onChange` inside `removeRow`, with the array length post-removal. */
  function focusAfterRemove(removedIndex: number, newLength: number) {
    pendingFocusIndex.current = newLength === 0 ? -1 : Math.min(removedIndex, newLength - 1);
  }

  useLayoutEffect(() => {
    if (pendingFocusIndex.current === null) return;
    const target = pendingFocusIndex.current;
    pendingFocusIndex.current = null;

    if (target === -1) {
      addButtonRef.current?.focus();
    } else {
      removeButtonRefs.current.get(target)?.focus();
    }
  });

  return { registerRemoveButton, registerAddButton, focusAfterRemove };
}
