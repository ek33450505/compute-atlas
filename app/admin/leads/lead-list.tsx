"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Clock, ExternalLink } from "lucide-react";

import type {
  LeadTriage,
  AdminLeadRow,
  LeadSubmissionOutcome,
  StageLeadInput,
} from "@/lib/lead-fields";
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
  stageLeadSubmissionAction,
  dismissLeadAction,
  resetLeadToNewAction,
} from "@/app/admin/leads/actions";

function formatActionError(result: { error: string }): string {
  return result.error || "Failed to update lead.";
}

/**
 * http/https only. Every value this file uses as a link target goes through
 * here, and both callers need it for different reasons:
 *
 * - `triage.finalUrl` comes from following redirects on a URL an anonymous
 *   stranger submitted, so it is unvalidated attacker input — this is its only
 *   check, same as the security note on TriagePanel below.
 * - `lead.url` is already intake-validated (`httpUrlSchema` rejects every
 *   non-http(s) scheme before `createLead` writes a row), so this is a second
 *   layer rather than the only one. Keep it anyway: that schema lives in
 *   another module and is invisible from here, so nothing in this file would
 *   fail if it were loosened, and a `javascript:` href in the admin UI is
 *   stored XSS. Defence in depth — do not drop the guard because the intake
 *   side "already handles it".
 *
 * A failing value renders as plain text, never as an anchor.
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
  // `deferred` (the lane tried and could not extract a usable candidate)
  // shares `secondary` with `researching`: both are muted, non-final,
  // in-flight states. It must NOT read as a rejection (`destructive`) or a
  // success (`default`), and `outline` stays reserved for `new` so the one
  // status the discovery lane actually queues is visually distinct from every
  // status that has left that queue. The badge prints the status text itself,
  // so `deferred` and `researching` are never confusable on screen.
  if (status === "deferred") return "secondary";
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
 *
 * `finalUrl` is also the one value here used as a link target, so it additionally
 * passes isSafeHttpUrl above — as does `lead.url` in LeadRowCard. That rule is
 * not specific to triage fields; see the helper's comment for why the guard
 * stands on both, including the intake-validated one.
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

const TEXTAREA_CLASS =
  "rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function buildCreateTemplate(sourceUrl: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return JSON.stringify(
    {
      id: "",
      name: "",
      operator: "",
      facilityType: "data_center",
      status: "proposed",
      confidence: "rumored",
      location: { lat: null, lon: null, state: "", city: "", precision: "approximate" },
      sources: [{ url: sourceUrl, label: "", retrievedAt: today, kind: "press" }],
      lastUpdated: today,
    },
    null,
    2
  );
}

interface StageIssue {
  path?: unknown;
  message?: unknown;
}

function formatIssue(issue: StageIssue): string {
  const path = Array.isArray(issue.path) ? issue.path.join(".") : "";
  const message = typeof issue.message === "string" ? issue.message : "Invalid";
  return path ? `${path}: ${message}` : message;
}

/**
 * Stages a pending submission from a lead. Staging only: the maintainer still
 * approves it from /admin/submissions. JSON.parse here is UX only — the server
 * action re-validates everything against facilitySchema.
 */
function StageDialog({
  lead,
  duplicateIds,
  open,
  onOpenChange,
}: {
  lead: AdminLeadRow;
  duplicateIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const singleDuplicate = duplicateIds.length === 1 ? duplicateIds[0] : "";
  const [kind, setKind] = useState<"create" | "update">(singleDuplicate ? "update" : "create");
  const [targetId, setTargetId] = useState(singleDuplicate);
  const [payloadText, setPayloadText] = useState("");
  const [sourcesText, setSourcesText] = useState("");
  const [note, setNote] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  const idPrefix = `stage-${lead.id}`;
  const describedBy =
    [kind === "update" ? `${idPrefix}-payload-help` : null, parseError ? `${idPrefix}-payload-error` : null]
      .filter(Boolean)
      .join(" ") || undefined;

  function handleSubmit() {
    setIssues([]);
    let payload: unknown;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      setParseError("Payload is not valid JSON.");
      return;
    }
    setParseError(null);

    const extraSources = sourcesText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const input: StageLeadInput = {
      kind,
      ...(kind === "update" ? { targetFacilityId: targetId.trim() } : {}),
      payload,
      ...(extraSources.length > 0 ? { extraSources } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };

    startTransition(async () => {
      const result = await stageLeadSubmissionAction(lead.id, input);
      if (result.ok) {
        const short = result.submissionId.slice(0, 8);
        if (result.leadPromoted) {
          toast.success(`Staged as submission ${short} — approve it in Submissions`);
        } else if (lead.status === "promoted") {
          toast.success(`Staged as submission ${short} (lead already linked to an earlier submission)`);
        } else {
          toast.warning(
            `Staged as submission ${short} — but the lead could not be linked; refresh before staging again.`
          );
        }
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(formatActionError(result));
        if (Array.isArray(result.issues)) {
          setIssues(result.issues.slice(0, 5).map((issue) => formatIssue(issue as StageIssue)));
        }
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Stage as submission</DialogTitle>
          <DialogDescription>
            Creates a pending submission from this lead. Nothing goes live until you approve it in
            Submissions.
          </DialogDescription>
        </DialogHeader>
        <div
          tabIndex={0}
          role="group"
          aria-label="Stage submission form"
          className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-medium">Kind</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${idPrefix}-kind`}
                checked={kind === "create"}
                onChange={() => setKind("create")}
                className="focus-visible:ring-2 focus-visible:ring-ring"
              />
              New facility
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${idPrefix}-kind`}
                checked={kind === "update"}
                onChange={() => setKind("update")}
                className="focus-visible:ring-2 focus-visible:ring-ring"
              />
              Update existing facility
            </label>
          </fieldset>
          {kind === "update" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${idPrefix}-target`}>Target facility id</Label>
              <input
                id={`${idPrefix}-target`}
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                className={`h-9 ${TEXTAREA_CLASS}`}
              />
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={`${idPrefix}-payload`}>Payload JSON</Label>
              {kind === "create" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setPayloadText(buildCreateTemplate(lead.url))}
                >
                  Insert template
                </Button>
              ) : null}
            </div>
            {kind === "update" ? (
              <p id={`${idPrefix}-payload-help`} className="text-xs text-muted-foreground">
                Top-level keys replace the existing value wholesale — send complete nested objects
                (e.g. the full `water` object).
              </p>
            ) : null}
            <textarea
              id={`${idPrefix}-payload`}
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
              aria-describedby={describedBy}
              aria-invalid={parseError ? true : undefined}
              spellCheck={false}
              className={`min-h-48 font-mono ${TEXTAREA_CLASS}`}
            />
            {parseError ? (
              <p id={`${idPrefix}-payload-error`} role="alert" className="text-xs text-destructive">
                {parseError}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-sources`}>Extra source URLs (one per line, optional)</Label>
            <textarea
              id={`${idPrefix}-sources`}
              value={sourcesText}
              onChange={(e) => setSourcesText(e.target.value)}
              className={`min-h-16 ${TEXTAREA_CLASS}`}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${idPrefix}-note`}>Note (optional)</Label>
            <input
              id={`${idPrefix}-note`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={lead.note ?? undefined}
              className={`h-9 ${TEXTAREA_CLASS}`}
            />
          </div>
          {issues.length > 0 ? (
            <ul role="alert" className="list-disc pl-5 text-xs text-destructive">
              {issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="outline" type="button">
                Cancel
              </Button>
            }
          />
          <Button disabled={isPending || !payloadText.trim()} onClick={handleSubmit}>
            Stage submission
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const LINK_CLASS =
  "text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** UTC calendar date, so the label is identical on the server, the client and CI. */
function formatReviewDate(value: Date | string): string {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function outcomeLabel(outcome: LeadSubmissionOutcome): string {
  if (outcome.status === "pending") return "Pending";
  const verb = outcome.status === "approved" ? "Approved" : "Rejected";
  return outcome.reviewedAt ? `${verb} ${formatReviewDate(outcome.reviewedAt)}` : verb;
}

/** The review outcome of each submission staged from a lead. Text carries the status, not color. */
function SubmissionOutcomes({ outcomes }: { outcomes: LeadSubmissionOutcome[] }) {
  return (
    <ul aria-label="Staged submissions" className="flex flex-col gap-1.5 text-xs">
      {outcomes.map((outcome) => (
        <li key={outcome.id} className="flex flex-wrap items-center gap-2">
          <Badge
            variant={
              outcome.status === "rejected"
                ? "destructive"
                : outcome.status === "approved"
                  ? "default"
                  : "outline"
            }
          >
            {outcomeLabel(outcome)}
          </Badge>
          <span className="text-muted-foreground">{outcome.kind}</span>
          {outcome.status === "approved" && outcome.facilityId ? (
            <Link
              href={`/facilities/${outcome.facilityId}`}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`View facility ${outcome.facilityId} (opens in new tab)`}
              className={LINK_CLASS}
            >
              {outcome.facilityId}
            </Link>
          ) : (
            <Link
              href="/admin/submissions"
              aria-label={`Submission ${outcome.id}${outcome.facilityId ? ` for ${outcome.facilityId}` : ""} in Submissions`}
              className={LINK_CLASS}
            >
              {outcome.facilityId ?? outcome.id.slice(0, 8)}
            </Link>
          )}
          {outcome.status === "rejected" && outcome.reviewNote ? (
            <span className="text-muted-foreground">Reason: {outcome.reviewNote}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function LeadRowCard({
  lead,
  outcomes,
}: {
  lead: AdminLeadRow;
  outcomes: LeadSubmissionOutcome[];
}) {
  const router = useRouter();
  const [dismissOpen, setDismissOpen] = useState(false);
  const [stageOpen, setStageOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  const attributionLabel = lead.attribution?.trim() ? lead.attribution : "anonymous";
  const urlIsSafe = isSafeHttpUrl(lead.url);
  const triage = lead.triage as LeadTriage | null;
  const duplicateIds = triage?.ok ? (triage.duplicateFacilityIds ?? []) : [];
  // `deferred` is deliberately NOT terminal: the lane gave up on it, so a
  // human still needs the forward actions (promote / dismiss) as well as
  // "Return to new". Only a human-made final decision is terminal.
  const isTerminal = lead.status === "promoted" || lead.status === "dismissed";
  // The discovery lane queues `new` leads only, so every other status is a
  // one-way door out of it. Offer a way back from all four.
  const canReset = lead.status !== "new";
  // promoteLead() writes promotedSubmissionId in the same statement that sets
  // the status, so a promoted lead with a null id was marked promoted by hand
  // (legacy) and has no submission behind it.
  const promotedWithoutSubmission =
    lead.status === "promoted" && !lead.promotedSubmissionId && outcomes.length === 0;

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

  function handleReset() {
    startTransition(async () => {
      const result = await resetLeadToNewAction(lead.id);
      if (result.ok) {
        toast.success("Returned to new.");
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
            {urlIsSafe ? (
              <a
                href={lead.url}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`${lead.url} (opens in new tab)`}
                className="text-sm font-medium break-all underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {lead.url}
              </a>
            ) : (
              <span className="text-sm font-medium break-all">{lead.url}</span>
            )}
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
        {promotedWithoutSubmission ? (
          <p className="text-xs text-muted-foreground">
            Marked promoted manually — no submission was created.
          </p>
        ) : null}
        {outcomes.length > 0 ? <SubmissionOutcomes outcomes={outcomes} /> : null}
        {outcomes.length === 0 && lead.promotedSubmissionId ? (
          <p className="text-xs text-muted-foreground">
            Staged as submission{" "}
            <Link
              href="/admin/submissions"
              className="text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {lead.promotedSubmissionId}
            </Link>
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {lead.status !== "dismissed" ? (
            <Button size="sm" disabled={isPending} onClick={() => setStageOpen(true)}>
              {lead.status === "promoted" ? "Stage another submission" : "Stage as submission"}
            </Button>
          ) : null}
          {!isTerminal ? (
            <>
              {lead.status === "new" ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isPending}
                  onClick={handleResearching}
                >
                  Start researching
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={isPending}
                onClick={() => setDismissOpen(true)}
              >
                Dismiss
              </Button>
            </>
          ) : null}
          {canReset ? (
            <Button size="sm" variant="outline" disabled={isPending} onClick={handleReset}>
              Return to new
            </Button>
          ) : null}
        </div>
      </div>

      {/* Mounted only while open so every open starts from fresh defaults. */}
      {stageOpen ? (
        <StageDialog
          lead={lead}
          duplicateIds={duplicateIds}
          open={stageOpen}
          onOpenChange={setStageOpen}
        />
      ) : null}

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
  outcomes = {},
}: {
  leads: AdminLeadRow[];
  activeStatus: LeadStatus;
  outcomes?: Record<string, LeadSubmissionOutcome[]>;
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
                  <LeadRowCard key={lead.id} lead={lead} outcomes={outcomes[lead.id] ?? []} />
                ))}
              </div>
            )
          ) : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}
