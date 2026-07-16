"use client";

import { useState, useTransition } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import type { SubmissionRow } from "@/lib/db/schema";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { approveSubmissionAction, rejectSubmissionAction } from "@/app/admin/submissions/actions";

const STATUS_TABS = ["pending", "approved", "rejected"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

interface ProvenanceShape {
  sources: string[];
  confidence?: string;
  discoveredBy: string;
  runId?: string;
  discoveredAt?: string;
  note?: string;
}

function getPayloadName(payload: unknown): string {
  if (payload && typeof payload === "object" && "name" in payload) {
    const name = (payload as Record<string, unknown>).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return "(untitled candidate)";
}

/**
 * Formats a failed approve/reject action result into a legible toast
 * message. `result.error` alone is often a generic envelope message (e.g.
 * "Invalid facility") produced by `facilitySchema.safeParse` failures —
 * the actionable detail lives in `result.issues` (a Zod issues array,
 * typed `unknown` at this boundary since it crosses the server-action
 * wire). Surfaces the first issue's path + message so a real validation
 * failure (e.g. a sourceIndex out-of-range) isn't misread as something
 * else entirely.
 */
function formatActionError(result: { error: string; issues?: unknown }): string {
  const issues = Array.isArray(result.issues) ? result.issues : [];
  if (issues.length === 0) return result.error || "Failed to approve submission.";
  const first = issues[0] as { path?: unknown[]; message?: unknown };
  const path = Array.isArray(first?.path) ? first.path.join(".") : "";
  const msg = typeof first?.message === "string" ? first.message : "";
  const detail = [path, msg].filter(Boolean).join(": ");
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
  return detail ? `${result.error} — ${detail}${more}` : result.error;
}

interface KindBadgeInfo {
  label: string;
  variant: "default" | "secondary" | "outline";
}

/**
 * `SubmissionRow["kind"]` widens to `string` at the DB layer (drizzle
 * `text()` columns aren't literal-typed), so this is a plain lookup
 * function — matching `getPayloadName`'s style — rather than a `Record`
 * keyed off the column type, which would silently accept unknown kinds.
 */
function getKindBadge(kind: string): KindBadgeInfo {
  if (kind === "create") return { label: "New facility", variant: "default" };
  if (kind === "status_update") return { label: "Status update", variant: "outline" };
  return { label: "Update", variant: "secondary" };
}

function getProvenance(row: SubmissionRow): ProvenanceShape {
  const raw = row.provenance as Partial<ProvenanceShape> | null | undefined;
  return {
    sources: Array.isArray(raw?.sources) ? raw!.sources : [],
    confidence: raw?.confidence,
    discoveredBy: raw?.discoveredBy ?? "unknown",
    runId: raw?.runId,
    discoveredAt: raw?.discoveredAt,
    note: raw?.note,
  };
}

function SubmissionRowCard({
  submission,
  detail,
}: {
  submission: SubmissionRow;
  detail: ReactNode;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  const provenance = getProvenance(submission);
  const payloadName = getPayloadName(submission.payload);
  // status_update (and some update) intents carry no facility `name` — the
  // payload is a transition/patch, not a doc. Fall back to the target
  // facility id as the primary label instead of the generic "(untitled
  // candidate)" placeholder, and skip the separate "(id)" suffix below so
  // the id isn't shown twice.
  const usesTargetIdLabel = payloadName === "(untitled candidate)" && !!submission.targetFacilityId;
  const facilityLabel = usesTargetIdLabel
    ? (submission.targetFacilityId as string)
    : payloadName;
  const isReviewable = submission.status === "pending";
  const kindBadge = getKindBadge(submission.kind);

  function handleApprove() {
    startTransition(async () => {
      const result = await approveSubmissionAction(submission.id);
      if (result.ok) {
        toast.success(`Approved "${facilityLabel}" — now live.`);
        router.refresh();
      } else {
        toast.error(formatActionError(result));
      }
    });
  }

  function handleReject() {
    const trimmed = reason.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const result = await rejectSubmissionAction(submission.id, trimmed);
      if (result.ok) {
        toast.success(`Rejected "${facilityLabel}".`);
        setRejectOpen(false);
        setReason("");
        router.refresh();
      } else {
        toast.error(formatActionError(result));
      }
    });
  }

  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={kindBadge.variant}>{kindBadge.label}</Badge>
            <span className="text-sm font-medium">{facilityLabel}</span>
            {submission.targetFacilityId && !usesTargetIdLabel ? (
              <span className="text-xs text-muted-foreground">({submission.targetFacilityId})</span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {provenance.discoveredBy} · {provenance.sources.length} source
            {provenance.sources.length === 1 ? "" : "s"}
            {provenance.confidence ? ` · ${provenance.confidence} confidence` : ""} · submitted{" "}
            {new Date(submission.createdAt).toLocaleDateString()}
          </p>
          {submission.reviewNote ? (
            <p className="text-xs text-muted-foreground">Note: {submission.reviewNote}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-label={expanded ? `Hide details for ${facilityLabel}` : `View details for ${facilityLabel}`}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Hide details" : "View details"}
          </Button>
          {isReviewable ? (
            <>
              <Button size="sm" disabled={isPending} onClick={handleApprove}>
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={isPending}
                onClick={() => setRejectOpen(true)}
              >
                Reject
              </Button>
            </>
          ) : null}
        </div>
      </div>
      {expanded ? (
        <div className="border-t border-border p-4">
          {detail}
        </div>
      ) : null}

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject &ldquo;{facilityLabel}&rdquo;</DialogTitle>
            <DialogDescription>
              Provide a reason for rejecting this submission. This is required and will be stored
              with the submission record.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`reject-reason-${submission.id}`}>Reason</Label>
            <textarea
              id={`reject-reason-${submission.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="min-h-20 rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              autoFocus
            />
          </div>
          <DialogFooter>
            <DialogClose
              render={
                <Button variant="outline" onClick={() => setReason("")}>
                  Cancel
                </Button>
              }
            />
            <Button disabled={isPending || !reason.trim()} onClick={handleReject}>
              Confirm reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function SubmissionList({
  submissions,
  activeStatus,
  details,
}: {
  submissions: SubmissionRow[];
  activeStatus: StatusTab;
  details: Record<string, ReactNode>;
}) {
  const router = useRouter();

  function handleTabChange(value: unknown) {
    const next = value as StatusTab;
    router.push(`/admin/submissions?status=${next}`);
  }

  return (
    <Tabs value={activeStatus} onValueChange={handleTabChange}>
      <TabsList>
        {STATUS_TABS.map((tab) => (
          <TabsTrigger key={tab} value={tab}>
            {tab[0].toUpperCase() + tab.slice(1)}
          </TabsTrigger>
        ))}
      </TabsList>
      {STATUS_TABS.map((tab) => (
        <TabsContent key={tab} value={tab}>
          {tab === activeStatus ? (
            submissions.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No {tab} submissions.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {submissions.map((submission) => (
                  <SubmissionRowCard
                    key={submission.id}
                    submission={submission}
                    detail={details[submission.id]}
                  />
                ))}
              </div>
            )
          ) : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}
