"use client";

import { useState, useTransition } from "react";
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
import { SubmissionDetail } from "@/app/admin/submissions/submission-detail";
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

function SubmissionRowCard({ submission }: { submission: SubmissionRow }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  const provenance = getProvenance(submission);
  const facilityLabel = getPayloadName(submission.payload);
  const isReviewable = submission.status === "pending";

  function handleApprove() {
    startTransition(async () => {
      const result = await approveSubmissionAction(submission.id);
      if (result.ok) {
        toast.success(`Approved "${facilityLabel}" — now live.`);
        router.refresh();
      } else {
        toast.error(result.error || "Failed to approve submission.");
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
        toast.error(result.error || "Failed to reject submission.");
      }
    });
  }

  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={submission.kind === "create" ? "default" : "secondary"}>
              {submission.kind === "create" ? "New facility" : "Update"}
            </Badge>
            <span className="text-sm font-medium">{facilityLabel}</span>
            {submission.targetFacilityId ? (
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
          <SubmissionDetail submission={submission} />
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
}: {
  submissions: SubmissionRow[];
  activeStatus: StatusTab;
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
                  <SubmissionRowCard key={submission.id} submission={submission} />
                ))}
              </div>
            )
          ) : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}
