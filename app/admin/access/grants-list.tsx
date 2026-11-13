"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { ListGrant } from "@/app/admin/access/grant-views";
import type { DatasetGrantStatus } from "@/lib/db/schema";
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
import {
  extendDatasetGrantAction,
  reissueDatasetLinkAction,
  revokeDatasetGrantAction,
} from "@/app/admin/access/actions";
import {
  ACTION_FAILED,
  DateText,
  LOCK_RELEASE_MS,
  LOCKED_CLASS,
  FOCUS_HEADING_CLASS,
  ResultRegion,
  TEXTAREA_CLASS,
  WorkingText,
  useResultReporter,
  type QueueResult,
} from "@/app/admin/access/shared";
import { describeMailOutcome } from "@/app/admin/access/mail-outcome";

/**
 * Hard-coded, not imported from lib/db/schema.ts: that module pulls drizzle-orm into the client
 * bundle for the sake of six strings. `satisfies` catches a typo; the test pins the list (and its
 * order) against DATASET_GRANT_STATUSES so a new status cannot be silently missing from the filter.
 */
export const GRANT_STATUSES = [
  "unverified",
  "pending_review",
  "active",
  "expired",
  "revoked",
  "rejected",
] as const satisfies readonly DatasetGrantStatus[];

const statusLabel = (status: DatasetGrantStatus) => status.replaceAll("_", " ");

function badgeVariant(status: DatasetGrantStatus): "default" | "secondary" | "outline" | "destructive" {
  if (status === "active") return "default";
  if (status === "revoked" || status === "rejected") return "destructive";
  if (status === "expired") return "secondary";
  return "outline";
}

/** Why a grant's term reads as it does. Text, so state never rests on color alone. */
function expiryNote(grant: ListGrant): string | null {
  if (grant.live) return "live";
  if (grant.status !== "active") return null;
  return grant.renewalPending
    ? "expired, downloads are paused until the renewal is approved"
    : "expired, downloads have stopped";
}

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pending,
  onConfirm,
  finalFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
  /** Where focus goes when the dialog closes: see GrantRow's `restoreFocus`. */
  finalFocus: ComponentProps<typeof DialogContent>["finalFocus"];
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent finalFocus={finalFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button
            variant="destructive"
            aria-disabled={pending || undefined}
            className={LOCKED_CLASS}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GrantRow({
  grant,
  activeStatus,
  onResult,
  headingRef,
}: {
  grant: ListGrant;
  activeStatus: DatasetGrantStatus;
  onResult: (result: QueueResult, row?: Element | null) => void;
  headingRef: RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<"revoke" | "reissue" | null>(null);
  const [reason, setReason] = useState("");
  // Set once an action succeeds; the refreshed row arrives as a new `grant` object and clears it.
  const [doneFor, setDoneFor] = useState<ListGrant | null>(null);
  const idPrefix = useId();
  const rowRef = useRef<HTMLElement>(null);
  const titleId = `${idPrefix}-title`;
  const reasonId = `${idPrefix}-reason`;

  // If the refresh never replaces the row, release the lock rather than leave it stuck. The server
  // re-checks every action, so a stale second click is refused there.
  useEffect(() => {
    if (!doneFor) return;
    const timer = setTimeout(() => setDoneFor(null), LOCK_RELEASE_MS);
    return () => clearTimeout(timer);
  }, [doneFor]);

  // A dialog restores focus to whatever opened it on close. After a confirmed action that element may
  // be gone once the refresh lands (focus would fall to <body>), so the list heading takes it
  // instead. A cancelled dialog keeps the default: back to the button that opened it.
  const focusHeadingOnClose = useRef(false);
  const restoreFocus = useCallback(() => {
    if (!focusHeadingOnClose.current) return true;
    focusHeadingOnClose.current = false;
    return headingRef.current;
  }, [headingRef]);
  function closeAfterAction() {
    focusHeadingOnClose.current = true;
    setConfirm(null);
  }

  const locked = isPending || doneFor === grant;
  const canExtend = grant.live || grant.renewalPending;
  const canReissue = grant.live;
  const canRevoke = grant.status === "active";
  const note = expiryNote(grant);

  // `row` is captured at click time: the row may be gone by the time the action resolves.
  function fail(error: string, row: Element | null) {
    onResult({ tone: "error", text: `${grant.name}: ${error}` }, row);
  }

  // A refusal usually means the row is stale: show what the server has now.
  function refused(error: string, row: Element | null) {
    fail(error, row);
    router.refresh();
  }

  function handleExtend() {
    if (locked) return;
    const row = rowRef.current;
    startTransition(async () => {
      try {
        const result = await extendDatasetGrantAction(grant.id);
        if (!result.ok) return refused(result.error, row);
        onResult(
          {
            tone: "success",
            text: `Extended access for ${grant.name} by a fresh 90-day term. No email is sent.`,
          },
          row,
        );
        setDoneFor(grant);
        router.refresh();
      } catch {
        fail(ACTION_FAILED, row);
      }
    });
  }

  function handleRevoke() {
    if (locked) return;
    const row = rowRef.current;
    startTransition(async () => {
      try {
        const result = await revokeDatasetGrantAction(grant.id, reason.trim() || undefined);
        closeAfterAction();
        if (!result.ok) return refused(result.error, row);
        setReason("");
        const revoked = `Revoked access for ${grant.name}. The link no longer works. No email was sent.`;
        if (result.subscription === "failed") {
          onResult(
            {
              tone: "warning",
              label: "Warning.",
              text: `${revoked} Revoked here, but the PayPal subscription could not be cancelled: cancel it in PayPal now (the next payment is not cancelled automatically; it raises a revoked_still_billing alert).`,
            },
            row,
          );
        } else if (result.subscription === "unknown") {
          onResult(
            {
              tone: "warning",
              label: "Warning.",
              text: `${revoked} Could not check whether this grant has a PayPal subscription; if it is a commercial grant, confirm the subscription is cancelled in PayPal.`,
            },
            row,
          );
        } else if (result.subscription === "cancelled") {
          onResult(
            {
              tone: "success",
              text: `${revoked} Subscription cancelled in PayPal. No refund was issued; refund in PayPal if needed.`,
            },
            row,
          );
        } else {
          onResult({ tone: "success", text: revoked }, row);
        }
        setDoneFor(grant);
        router.refresh();
      } catch {
        closeAfterAction();
        fail(ACTION_FAILED, row);
      }
    });
  }

  function handleReissue() {
    if (locked) return;
    const row = rowRef.current;
    startTransition(async () => {
      try {
        const result = await reissueDatasetLinkAction(grant.id);
        closeAfterAction();
        if (!result.ok) return refused(result.error, row);
        const outcome = describeMailOutcome(result.mail, "link_reissued");
        onResult(
          {
            tone: outcome.delivered ? "success" : "warning",
            text: `Reissued the link for ${grant.name}. The old link no longer works. ${outcome.text}`,
          },
          row,
        );
        setDoneFor(grant);
        router.refresh();
      } catch {
        closeAfterAction();
        fail(ACTION_FAILED, row);
      }
    });
  }

  return (
    <article
      ref={rowRef}
      aria-labelledby={titleId}
      aria-busy={isPending || undefined}
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={titleId} className="text-sm font-semibold break-words">
          {grant.name}
        </h3>
        <Badge variant={badgeVariant(grant.status)}>{statusLabel(grant.status)}</Badge>
      </div>

      <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-xs font-medium text-muted-foreground">Email (verified)</dt>
        <dd className="break-all">{grant.email}</dd>
        {grant.organization ? (
          <>
            <dt className="text-xs font-medium text-muted-foreground">
              Organization (as submitted, not verified)
            </dt>
            <dd className="break-words">{grant.organization}</dd>
          </>
        ) : null}
        <dt className="text-xs font-medium text-muted-foreground">Tier</dt>
        <dd>{grant.tier === "commercial" ? "Commercial" : "Free"}</dd>
        {grant.tier === "commercial" ? (
          <>
            <dt className="text-xs font-medium text-muted-foreground">Paid through</dt>
            <dd>{grant.paidThrough ? <DateText value={grant.paidThrough} /> : "not yet paid"}</dd>
            <dt className="text-xs font-medium text-muted-foreground">PayPal subscription</dt>
            <dd>{grant.subscriptionLinked ? "linked" : "none linked"}</dd>
          </>
        ) : null}
        <dt className="text-xs font-medium text-muted-foreground">Created</dt>
        <dd>
          <DateText value={grant.createdAt} />
        </dd>
        {grant.approvedAt ? (
          <>
            <dt className="text-xs font-medium text-muted-foreground">Approved</dt>
            <dd>
              <DateText value={grant.approvedAt} />
            </dd>
          </>
        ) : null}
        {grant.expiresAt ? (
          <>
            <dt className="text-xs font-medium text-muted-foreground">Expires</dt>
            <dd>
              <DateText value={grant.expiresAt} />
              {note ? (
                <>
                  {" "}
                  <span className={grant.live ? "text-muted-foreground" : "font-medium text-destructive"}>
                    ({note})
                  </span>
                </>
              ) : null}
            </dd>
          </>
        ) : null}
        {grant.renewalRequestedAt ? (
          <>
            <dt className="text-xs font-medium text-muted-foreground">Renewal requested</dt>
            <dd>
              <DateText value={grant.renewalRequestedAt} />
            </dd>
          </>
        ) : null}
        {grant.revokedAt ? (
          <>
            <dt className="text-xs font-medium text-muted-foreground">Revoked</dt>
            <dd>
              <DateText value={grant.revokedAt} />
            </dd>
          </>
        ) : null}
        <dt className="text-xs font-medium text-muted-foreground">Downloads</dt>
        <dd>{grant.downloadCount}</dd>
        {grant.lastDownloadAt ? (
          <>
            <dt className="text-xs font-medium text-muted-foreground">Last download</dt>
            <dd>
              <DateText value={grant.lastDownloadAt} />
            </dd>
          </>
        ) : null}
        {grant.reviewNote ? (
          <>
            <dt className="text-xs font-medium text-muted-foreground">Review note</dt>
            <dd className="break-words whitespace-pre-wrap">{grant.reviewNote}</dd>
          </>
        ) : null}
        {grant.rejectionNote ? (
          <>
            <dt className="text-xs font-medium text-muted-foreground">Rejection note</dt>
            <dd className="break-words whitespace-pre-wrap">{grant.rejectionNote}</dd>
          </>
        ) : null}
        {grant.revokeReason ? (
          <>
            <dt className="text-xs font-medium text-muted-foreground">Revoke reason</dt>
            <dd className="break-words whitespace-pre-wrap">{grant.revokeReason}</dd>
          </>
        ) : null}
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        {canExtend ? (
          <Button
            size="sm"
            variant="outline"
            aria-disabled={locked || undefined}
            className={LOCKED_CLASS}
            onClick={handleExtend}
            aria-label={`Extend access for ${grant.name}`}
          >
            Extend
          </Button>
        ) : null}
        {canReissue ? (
          <Button
            size="sm"
            variant="outline"
            aria-disabled={locked || undefined}
            className={LOCKED_CLASS}
            onClick={() => {
              if (!locked) setConfirm("reissue");
            }}
            aria-label={`Reissue link for ${grant.name}`}
          >
            Reissue link
          </Button>
        ) : null}
        {canRevoke ? (
          <Button
            size="sm"
            variant="outline"
            aria-disabled={locked || undefined}
            className={LOCKED_CLASS}
            onClick={() => {
              if (!locked) setConfirm("revoke");
            }}
            aria-label={`Revoke access for ${grant.name}`}
          >
            Revoke
          </Button>
        ) : null}
        <Link
          href={`?status=${activeStatus}&grant=${grant.id}`}
          className="inline-flex min-h-6 items-center text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          Download log<span className="sr-only"> for {grant.name}</span>
        </Link>
        {isPending ? <WorkingText /> : null}
      </div>

      {canRevoke ? (
        <ConfirmDialog
          open={confirm === "revoke"}
          onOpenChange={(open) => setConfirm(open ? "revoke" : null)}
          title={`Revoke access for ${grant.name}?`}
          description={
            grant.tier === "commercial"
              ? "The link stops working at once and the PayPal subscription is cancelled. No refund is issued and no email is sent to the requester."
              : "The link stops working at once. No email is sent to the requester."
          }
          confirmLabel="Confirm revoke"
          pending={locked}
          onConfirm={handleRevoke}
          finalFocus={restoreFocus}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={reasonId}>Reason (optional, internal)</Label>
            <textarea
              id={reasonId}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className={TEXTAREA_CLASS}
            />
          </div>
        </ConfirmDialog>
      ) : null}
      {canReissue ? (
        <ConfirmDialog
          open={confirm === "reissue"}
          onOpenChange={(open) => setConfirm(open ? "reissue" : null)}
          title={`Reissue the link for ${grant.name}?`}
          description="The current link stops working at once and a new link is emailed."
          confirmLabel="Confirm reissue"
          pending={locked}
          onConfirm={handleReissue}
          finalFocus={restoreFocus}
        />
      ) : null}
    </article>
  );
}

export function GrantsList({
  grants,
  activeStatus,
}: {
  grants: ListGrant[];
  activeStatus: DatasetGrantStatus;
}) {
  const { state, report, headingRef } = useResultReporter();

  return (
    <section aria-labelledby="grants-heading" className="flex flex-col gap-3">
      <h2
        id="grants-heading"
        ref={headingRef}
        tabIndex={-1}
        className={`text-lg font-semibold ${FOCUS_HEADING_CLASS}`}
      >
        Grants
      </h2>
      <nav aria-label="Filter grants by status">
        <ul className="flex flex-wrap gap-2">
          {GRANT_STATUSES.map((status) => (
            <li key={status}>
              <Link
                href={`?status=${status}`}
                aria-current={status === activeStatus ? "page" : undefined}
                className={
                  status === activeStatus
                    ? "inline-flex h-8 items-center rounded-lg border border-foreground bg-muted px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring"
                    : "inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                }
              >
                {statusLabel(status)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p className="text-xs text-muted-foreground">
        Unauthenticated: names and organizations are as submitted, not verified. Only the email address
        was verified.
      </p>
      <ResultRegion result={state.result} seq={state.seq} />
      {grants.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No {statusLabel(activeStatus)} grants.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {grants.map((grant) => (
            <GrantRow
              key={grant.id}
              grant={grant}
              activeStatus={activeStatus}
              onResult={report}
              headingRef={headingRef}
            />
          ))}
        </div>
      )}
    </section>
  );
}
