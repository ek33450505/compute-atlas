"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { buildEditionNowAction } from "@/app/admin/access/actions";
import {
  ACTION_FAILED,
  FOCUS_HEADING_CLASS,
  LOCKED_CLASS,
  ResultRegion,
  WorkingText,
  useResultReporter,
  type QueueResult,
} from "@/app/admin/access/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AdminDatasetEdition } from "@/lib/dataset-admin";

// Type only: the runtime import would pull drizzle-orm into the client bundle (see GRANT_STATUSES).
type EditionStatus = AdminDatasetEdition["status"];

function badgeVariant(status: EditionStatus): "default" | "outline" | "destructive" {
  if (status === "published") return "default";
  if (status === "failed") return "destructive";
  return "outline";
}

/** Binary units, one decimal above bytes: "1.2 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

// UTC and fixed-format so the text never depends on the server's or browser's locale or timezone.
function formatTime(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function filesSummary(files: AdminDatasetEdition["files"]): string {
  if (files.length === 0) return "None";
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  return `${files.length} ${files.length === 1 ? "file" : "files"}, ${formatBytes(total)}`;
}

function changesSummary(changes: AdminDatasetEdition["changes"]): string {
  if (!changes) return "—";
  return `${changes.added} added, ${changes.updated} updated, ${changes.removed} removed`;
}

/** The result region text for a finished build. Dates are the server's UTC edition date. */
function describeBuild(result: Awaited<ReturnType<typeof buildEditionNowAction>>): QueueResult {
  if (!result.ok) {
    return { tone: "error", text: `Build failed (${result.code ?? "unknown"}).` };
  }
  switch (result.outcome) {
    case "published":
      return {
        tone: "success",
        text: `Published edition ${result.editionDate}: ${result.recordCount ?? 0} records.`,
      };
    case "alreadyPublished":
      return { tone: "info", text: `Today's edition (${result.editionDate}) is already published.` };
    case "inProgress":
      // Neutral, not a failure: "warning" would label it "Not delivered." (mail) and "success" would say "Done.".
      return {
        tone: "info",
        text: `A build for ${result.editionDate} is running or was just retried. Try again in a few minutes.`,
      };
    default:
      // The action's ok:true type still admits "failed"; it never sends it, but never read it as success.
      return { tone: "error", text: "Build failed (unknown)." };
  }
}

export function EditionsPanel({ editions }: { editions: AdminDatasetEdition[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const { state, report, headingRef } = useResultReporter();

  // No confirm step: a build is idempotent per UTC day (an already-published or running day is reported,
  // not rebuilt) and the files stay private until a grant downloads them.
  function handleBuild() {
    if (isPending) return;
    // No row is passed, so the focus rule leaves focus where it is when the button holds it (keyboard use,
    // Chrome clicks). Safari and Firefox on macOS do not focus a clicked button; focus is then on <body>,
    // counts as lost, and moves to the panel heading. Either way the start message is announced.
    report({ tone: "info", text: "Build started. This can take a few minutes." });
    startTransition(async () => {
      try {
        report(describeBuild(await buildEditionNowAction()));
      } catch {
        report({ tone: "error", text: ACTION_FAILED });
      }
      router.refresh();
    });
  }

  return (
    <section aria-labelledby="editions-heading" className="flex flex-col gap-3">
      <h2
        id="editions-heading"
        ref={headingRef}
        tabIndex={-1}
        className={`text-lg font-semibold ${FOCUS_HEADING_CLASS}`}
      >
        Editions
      </h2>
      <div aria-busy={isPending || undefined} className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          aria-disabled={isPending || undefined}
          className={LOCKED_CLASS}
          onClick={handleBuild}
        >
          Build now
        </Button>
        {isPending ? (
          <>
            <WorkingText />
            <span className="text-xs text-muted-foreground">Building… this can take a few minutes.</span>
          </>
        ) : null}
      </div>
      <ResultRegion result={state.result} seq={state.seq} />
      {editions.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No editions yet.</p>
      ) : (
        <Table>
          <TableCaption>Most recent editions, newest first.</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Edition date</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Built at</TableHead>
              <TableHead scope="col" className="text-right tabular-nums">Records</TableHead>
              <TableHead scope="col" className="text-right tabular-nums">Files</TableHead>
              <TableHead scope="col" className="text-right tabular-nums">Changes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {editions.map((edition) => (
              <TableRow key={edition.id}>
                <TableCell>{edition.editionDate}</TableCell>
                <TableCell>
                  <Badge variant={badgeVariant(edition.status)}>{edition.status}</Badge>
                </TableCell>
                <TableCell>
                  <time dateTime={edition.builtAt.toISOString()}>{formatTime(edition.builtAt)}</time>
                </TableCell>
                <TableCell className="text-right tabular-nums">{edition.recordCount ?? "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{filesSummary(edition.files)}</TableCell>
                <TableCell className="text-right tabular-nums">{changesSummary(edition.changes)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
