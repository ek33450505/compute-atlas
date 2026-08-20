"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Clock, ExternalLink } from "lucide-react";

import type { LeadTriage, AdminLeadRow } from "@/lib/lead-fields";
import { LEAD_STATUSES, type LeadStatus } from "@/lib/lead-fields";
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
import {
  markLeadResearchingAction,
  markLeadPromotedAction,
  dismissLeadAction,
} from "@/app/admin/leads/actions";

function formatActionError(result: { error: string }): string {
  return result.error || "Failed to update lead.";
}

/**
 * http/https only. `finalUrl` comes from following redirects on a URL an
 * anonymous stranger submitted — it must be validated before it's ever used
 * as a link target, same as the security note on TriagePanel below.
 */
function isSafeHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function getStatusBadgeVariant(
  status: string
): "default" | "secondary" | "outline" | "destructive" {
  if (status === "promoted") return "default";
  if (status === "dismissed") return "destructive";
  if (status === "researching") return "secondary";
  return "outline"; // new
}

/**
 * Renders a lead's submit-time triage result.
 *
 * SECURITY: `triage.title`, `triage.error`, and `triage.finalUrl` are
 * attacker-controlled strings scraped from an arbitrary public web page
 * submitted by an anonymous stranger. lib/url-triage.ts's decodeEntities
 * turns `&lt;` back into a literal `<` and does NOT strip tags, so these
 * values can legitimately contain `<script>`-shaped text. Below they are
 * rendered ONLY as plain JSX text children (e.g. `{triage.title}`) — React
 * escapes text children by default, so this is safe. Do NOT switch this to
 * dangerouslySetInnerHTML, splice these into an href/title built by string
 * concatenation, or otherwise treat them as trusted markup.
 */
function TriagePanel({ triage, submittedUrl }: { triage: LeadTriage | null; submittedUrl: string }) {
  if (!triage) {
    // A null triage means the submit-time fetch had not completed or the
    // serverless function was torn down before it could write the result —
    // this is NOT the same as "bad lead" and must never read as a failure.
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="size-3.5" aria-hidden="true" />
        Not checked yet
      </p>
    );
  }

  if (!triage.ok) {
    return (
      <div className="flex flex-col gap-1 text-xs">
        <p className="flex items-center gap-1.5 text-destructive">
          <AlertTriangle className="size-3.5" aria-hidden="true" />
          Source unreachable{triage.httpStatus ? ` (HTTP ${triage.httpStatus})` : ""}
        </p>
        {triage.error ? <p className="text-muted-foreground">{triage.error}</p> : null}
      </div>
    );
  }

  const finalUrlIsSafe = isSafeHttpUrl(triage.finalUrl);
  const redirected = finalUrlIsSafe && triage.finalUrl !== submittedUrl;

  return (
    <div className="flex flex-col gap-1 text-xs">
      <p className="flex items-center gap-1.5 text-foreground">
        <CheckCircle2 className="size-3.5" aria-hidden="true" />
        Reachable{triage.httpStatus ? ` (HTTP ${triage.httpStatus})` : ""}
        {triage.title ? <span className="text-muted-foreground"> — {triage.title}</span> : null}
      </p>
      {redirected ? (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <ExternalLink className="size-3.5" aria-hidden="true" />
          Redirected to{" "}
          {finalUrlIsSafe ? (
            <a
              href={triage.finalUrl}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`${triage.finalUrl} (opens in new tab)`}
              className="underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {triage.finalUrl}
            </a>
          ) : (
            triage.finalUrl
          )}
        </p>
      ) : null}
    </div>
  );
}

function LeadRowCard({ lead }: { lead: AdminLeadRow }) {
  const router = useRouter();
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  const attributionLabel = lead.attribution?.trim() ? lead.attribution : "anonymous";
  const triage = lead.triage as LeadTriage | null;
  const duplicateIds = triage?.ok ? (triage.duplicateFacilityIds ?? []) : [];
  const isTerminal = lead.status === "promoted" || lead.status === "dismissed";

  function handleResearching() {
    startTransition(async () => {
      const result = await markLeadResearchingAction(lead.id);
      if (result.ok) {
        toast.success("Moved to researching.");
        router.refresh();
      } else {
        toast.error(formatActionError(result));
      }
    });
  }

  function handlePromoted() {
    startTransition(async () => {
      const result = await markLeadPromotedAction(lead.id);
      if (result.ok) {
        toast.success("Marked promoted.");
        router.refresh();
      } else {
        toast.error(formatActionError(result));
      }
    });
  }

  function handleDismiss() {
    const trimmed = reason.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const result = await dismissLeadAction(lead.id, trimmed);
      if (result.ok) {
        toast.success("Lead dismissed.");
        setDismissOpen(false);
        setReason("");
        router.refresh();
      } else {
        toast.error(formatActionError(result));
      }
    });
  }

  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={getStatusBadgeVariant(lead.status)}>{lead.status}</Badge>
            <a
              href={lead.url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`${lead.url} (opens in new tab)`}
              className="text-sm font-medium break-all underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {lead.url}
            </a>
          </div>
          <p className="shrink-0 text-xs text-muted-foreground">
            {attributionLabel} · submitted {new Date(lead.createdAt).toLocaleDateString()}
          </p>
        </div>
        {lead.note ? <p className="text-sm text-foreground">{lead.note}</p> : null}
        <TriagePanel triage={triage} submittedUrl={lead.url} />
        {duplicateIds.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-foreground">Possible duplicate — already tracked:</span>
            {duplicateIds.map((id) => (
              <Link
                key={id}
                href={`/facilities/${id}`}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`View existing facility ${id} (opens in new tab)`}
                className="text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {id}
              </Link>
            ))}
          </div>
        ) : null}
        {lead.reviewNote ? (
          <p className="text-xs text-muted-foreground">Note: {lead.reviewNote}</p>
        ) : null}
        {!isTerminal ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {lead.status === "new" ? (
              <Button size="sm" variant="outline" disabled={isPending} onClick={handleResearching}>
                Start researching
              </Button>
            ) : null}
            <Button size="sm" disabled={isPending} onClick={handlePromoted}>
              Mark promoted
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={isPending}
              onClick={() => setDismissOpen(true)}
            >
              Dismiss
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog open={dismissOpen} onOpenChange={setDismissOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dismiss lead</DialogTitle>
            <DialogDescription>
              Provide a reason for dismissing this lead. This is required and will be stored with
              the lead record.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`dismiss-reason-${lead.id}`}>Reason</Label>
            <textarea
              id={`dismiss-reason-${lead.id}`}
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
            <Button disabled={isPending || !reason.trim()} onClick={handleDismiss}>
              Confirm dismiss
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function LeadList({
  leads,
  activeStatus,
}: {
  leads: AdminLeadRow[];
  activeStatus: LeadStatus;
}) {
  const router = useRouter();

  function handleTabChange(value: unknown) {
    const next = value as LeadStatus;
    router.push(`/admin/leads?status=${next}`);
  }

  return (
    <Tabs value={activeStatus} onValueChange={handleTabChange}>
      <TabsList>
        {LEAD_STATUSES.map((tab) => (
          <TabsTrigger key={tab} value={tab}>
            {tab[0].toUpperCase() + tab.slice(1)}
          </TabsTrigger>
        ))}
      </TabsList>
      {LEAD_STATUSES.map((tab) => (
        <TabsContent key={tab} value={tab}>
          {tab === activeStatus ? (
            leads.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No {tab} leads.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {leads.map((lead) => (
                  <LeadRowCard key={lead.id} lead={lead} />
                ))}
              </div>
            )
          ) : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}
