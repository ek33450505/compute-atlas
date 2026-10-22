"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TableRow } from "@/lib/facility-slim";
import { formatAsOfDate } from "@/lib/as-of";
import { facilitiesToCsv } from "@/lib/export";

/** Identifies the static full-record snapshot the JSON export downloads from. */
export interface ExportSnapshot {
  /** ISO timestamp (or "unknown") of the export that produced the snapshot; also the `?v=` cache key, shared with /data. */
  asOf: string;
}

const SNAPSHOT_URL = "/data/facilities.json";

/** Safari has aborted downloads whose Blob URL was revoked right after click(). */
const REVOKE_DELAY_MS = 1000;

function triggerDownload(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

function plural(n: number): string {
  return n === 1 ? "1 facility" : `${n.toLocaleString("en-US")} facilities`;
}

/**
 * Every "Downloaded …" message. The two common outcomes are kept to ~112
 * characters for 5-digit counts so they fit the live region's two-line
 * reservation. With `unreadable` entries among the missing ones the note is
 * rarer and may run longer, as may the nothing-downloaded messages.
 */
export function exportedMessage(
  found: number,
  wanted: number,
  snapshotLabel: string,
  unreadable = 0
): string {
  const missing = wanted - found;
  if (missing > 0 && unreadable > 0) {
    return `Downloaded ${plural(found)} (${snapshotLabel}; later edits aren't in it). ${missing.toLocaleString("en-US")} of ${plural(wanted)} ${missing === 1 ? "has" : "have"} no readable entry in the downloadable snapshot, which also had ${entries(unreadable)}, and ${missing === 1 ? "was" : "were"} left out.`;
  }
  return missing === 0
    ? `Downloaded ${plural(found)} (${snapshotLabel}; later edits aren't in it).`
    : `Downloaded ${found.toLocaleString("en-US")} of ${plural(wanted)} (${snapshotLabel}; newer ones and later edits aren't in it).`;
}

function snapshotUrl(snapshot: ExportSnapshot): string {
  return snapshot.asOf !== "unknown"
    ? `${SNAPSHOT_URL}?v=${encodeURIComponent(snapshot.asOf)}`
    : SNAPSHOT_URL;
}

/** What the export needs from a snapshot element; the rest is serialized untouched. */
type SnapshotRecord = { id: string } & Record<string, unknown>;

function isSnapshotRecord(f: unknown): f is SnapshotRecord {
  return typeof f === "object" && f !== null && "id" in f && typeof f.id === "string";
}

/** Fetches the static snapshot; throws on a network, HTTP or shape failure. */
async function fetchSnapshot(
  url: string,
  signal: AbortSignal
): Promise<{ records: SnapshotRecord[]; unreadable: number }> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("unexpected snapshot shape");
  const records = body.filter(isSnapshotRecord);
  return { records, unreadable: body.length - records.length };
}

function entries(n: number): string {
  return n === 1 ? "1 unreadable entry" : `${n.toLocaleString("en-US")} unreadable entries`;
}

export function ExportButtons({
  facilities,
  snapshot,
  children,
}: {
  facilities: TableRow[];
  snapshot: ExportSnapshot;
  /** Rendered beside the export group, outside it, so the message below spans them all. */
  children?: ReactNode;
}) {
  const empty = facilities.length === 0;
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const pendingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // A message describes one row set. When the rows change (filters), drop the
  // message and abandon any export in flight; derived during render, keyed on
  // the ids, so it fires only when the rows really change.
  const rowsKey = facilities.map((f) => f.id).join("\n");
  const [seenKey, setSeenKey] = useState(rowsKey);
  if (rowsKey !== seenKey) {
    setSeenKey(rowsKey);
    setMessage("");
    setPending(false);
  }
  // MUST stay useLayoutEffect, not useEffect: it aborts in the commit, before a
  // resolving fetch can download the old rows (no jsdom test can pin this).
  // React 19 does not warn about layout effects on the server.
  useLayoutEffect(() => {
    abortRef.current?.abort();
    pendingRef.current = false;
  }, [rowsKey]);

  // Abort an in-flight export on unmount so it never downloads or sets state late.
  useEffect(() => () => abortRef.current?.abort(), []);

  const asOf = formatAsOfDate(snapshot.asOf);
  const asOfShort = formatAsOfDate(snapshot.asOf, "short");
  const snapshotName = asOfShort ? `JSON snapshot, ${asOfShort}` : "deployed JSON snapshot";
  const jsonLabel = `Download ${plural(facilities.length)} as JSON (${
    asOf ? `snapshot as of ${asOf}` : "deployed snapshot"
  })`;

  function downloadCsv() {
    if (empty) return;
    triggerDownload(facilitiesToCsv(facilities), "compute-atlas-facilities.csv", "text/csv;charset=utf-8");
  }

  async function downloadJson() {
    // aria-disabled (not `disabled`) keeps focus on the button while it works
    // or when the list is empty, so the guard lives here; a ref for pending,
    // because a closure can be a render stale.
    if (empty || pendingRef.current) return;
    pendingRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    // Capture now: the filters may change while the snapshot is in flight.
    const wanted = facilities.map((f) => f.id);
    setPending(true);
    setMessage("Preparing JSON export…");
    try {
      const { records, unreadable } = await fetchSnapshot(snapshotUrl(snapshot), controller.signal);
      if (controller.signal.aborted) return;
      const byId = new Map(records.map((f) => [f.id, f]));
      const found: SnapshotRecord[] = [];
      for (const id of wanted) {
        const record = byId.get(id);
        if (record) found.push(record);
      }
      if (found.length === 0) {
        setMessage(
          unreadable > 0
            ? `Nothing was downloaded: the downloadable snapshot had ${entries(unreadable)} and has no readable entry for ${wanted.length === 1 ? "that facility" : "these facilities"}.`
            : wanted.length === 1
              ? "That facility isn't in the downloadable snapshot yet, so nothing was downloaded."
              : `None of the ${wanted.length.toLocaleString("en-US")} facilities are in the downloadable snapshot yet, so nothing was downloaded.`
        );
        return;
      }
      // Same pretty-printing as facilitiesToJson, but over snapshot records as-is.
      triggerDownload(JSON.stringify(found, null, 2), "compute-atlas-facilities.json", "application/json");
      setMessage(exportedMessage(found.length, wanted.length, snapshotName, unreadable));
    } catch {
      if (controller.signal.aborted) return;
      setMessage("Could not download the JSON snapshot. Nothing was downloaded; try again.");
    } finally {
      // Only the current export owns the flag (a superseded one must not clear it).
      if (abortRef.current === controller) pendingRef.current = false;
      if (!controller.signal.aborted) setPending(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-1 sm:w-auto sm:min-w-[22rem]">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Export facilities" className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-disabled={empty || undefined}
            aria-label={`Download ${plural(facilities.length)} as CSV`}
            className="aria-disabled:opacity-50"
            onClick={downloadCsv}
          >
            <Download className="size-4" aria-hidden="true" /> CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-disabled={empty || pending || undefined}
            aria-label={jsonLabel}
            className="aria-disabled:opacity-50"
            onClick={downloadJson}
          >
            <Download className="size-4" aria-hidden="true" /> JSON
          </Button>
        </div>
        {children}
      </div>
      {/* The message sits on its own line under the whole control row. The block
          always reserves two lines (the common success messages, at any width)
          and is never display:none or sr-only, so it is in the
          accessibility tree before its first message and filling it moves
          nothing below it. w-0 min-w-full: its text wraps inside the
          row's width instead of widening it. */}
      <p
        aria-live="polite"
        aria-atomic="true"
        className="min-h-8 w-0 min-w-full text-xs leading-4 text-muted-foreground"
      >
        {message}
      </p>
    </div>
  );
}
