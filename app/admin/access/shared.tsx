"use client";

import { useCallback, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";

export const TEXTAREA_CLASS =
  "min-h-16 w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-transparent disabled:cursor-not-allowed disabled:opacity-50";

export const ACTION_FAILED = "The request failed. Reload before retrying.";

/**
 * How long a successful action keeps its row locked while waiting for `router.refresh()` to swap in
 * a fresh row. If the refresh fails silently the lock would otherwise never clear. The server
 * re-checks every action, so a stale second click after the release is refused, not applied twice.
 */
export const LOCK_RELEASE_MS = 10_000;

/**
 * A locked control uses `aria-disabled`, never the native `disabled` attribute: a natively disabled
 * button that holds focus drops keyboard focus to <body> (WCAG 2.4.3). The handlers return early
 * while locked, so a click or Enter does nothing, and this class carries the disabled look.
 */
export const LOCKED_CLASS = "aria-disabled:pointer-events-none aria-disabled:opacity-50";

/** UTC calendar date, so the label is identical on the server, the client and CI. */
export function DateText({ value }: { value: Date | string }) {
  const date = new Date(value);
  return (
    <time dateTime={date.toISOString()}>
      {date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })}
    </time>
  );
}

/** `info` is neutral: nothing was done and nothing failed, so it carries no visible prefix. */
export type QueueResult = {
  tone: "success" | "info" | "warning" | "error";
  text: string;
  /** Overrides the tone's default prefix (the warning default is mail wording); `null` shows none. */
  label?: string | null;
};

const RESULT_LABEL: Record<QueueResult["tone"], string | null> = {
  success: "Done.",
  info: null,
  warning: "Not delivered.",
  error: "Error.",
};

function ResultMessage({ result }: { result: QueueResult }) {
  const neutral = result.tone === "success" || result.tone === "info";
  const label = result.label !== undefined ? result.label : RESULT_LABEL[result.tone];
  return (
    <p
      className={
        neutral
          ? "flex items-start gap-2 rounded-lg border border-border p-3 text-sm"
          : "flex items-start gap-2 rounded-lg border border-destructive bg-destructive/10 p-3 text-sm text-destructive"
      }
    >
      {result.tone === "success" ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      ) : result.tone === "info" ? (
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      ) : (
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      )}
      <span>
        {label ? <span className="font-semibold">{label} </span> : null}
        {result.text}
      </span>
    </p>
  );
}

/** Classes for a list heading that `useResultReporter` can focus (`tabIndex={-1}`, never a tab stop). */
export const FOCUS_HEADING_CLASS =
  "rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-transparent";

/**
 * Result state for one list, plus the focus move that goes with it. A successful action refreshes
 * the page and the row may unmount, so focus would otherwise fall to <body>. `report` therefore
 * moves focus to the list heading (`headingRef`), but ONLY when focus is lost (<body>) or still
 * inside the acting row (`row`, captured at click time). Anywhere else the admin put it on purpose:
 * a slow mail send resolving must not pull focus out of a note they are typing in another row, and
 * a dialog that is still open keeps its own focus (its `finalFocus` handles the close).
 * `seq` changes on every report so an identical consecutive message is re-announced.
 */
export function useResultReporter() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<{ result: QueueResult | null; seq: number }>({
    result: null,
    seq: 0,
  });
  const report = useCallback((result: QueueResult, row?: Element | null) => {
    setState((prev) => ({ result, seq: prev.seq + 1 }));
    const active = document.activeElement;
    const focusLost = !active || active === document.body;
    if (focusLost || (row && row.contains(active))) headingRef.current?.focus();
  }, []);
  return { state, report, headingRef };
}

/**
 * Lives at list level, not in the row: a successful action refreshes the page and the row may leave,
 * so anything held in row state would vanish with it. Two regions, both always mounted, so assistive
 * tech has registered each before text lands in it (changing one region's aria-live in the same
 * render as its text is unreliable): `status` (polite) takes success and info, `alert` (assertive) takes
 * undelivered mail and errors. The visible "Not delivered." / "Error." prefix keeps the meaning off color.
 * The regions carry the announcement; they are not a focus target (see `useResultReporter`).
 */
export function ResultRegion({ result, seq = 0 }: { result: QueueResult | null; seq?: number }) {
  const isPolite = result?.tone === "success" || result?.tone === "info";
  return (
    <div>
      <div role="status">
        {result && isPolite ? <ResultMessage key={seq} result={result} /> : null}
      </div>
      <div role="alert">
        {result && !isPolite ? <ResultMessage key={seq} result={result} /> : null}
      </div>
    </div>
  );
}

/** Visible busy text beside a row's controls while its request is in flight. */
export function WorkingText() {
  return <span className="text-xs text-muted-foreground">Working…</span>;
}
