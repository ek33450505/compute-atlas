"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { QueueGrant } from "@/app/admin/access/grant-views";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  approveDatasetGrantAction,
  rejectDatasetGrantAction,
} from "@/app/admin/access/actions";
import { describeMailOutcome } from "@/app/admin/access/mail-outcome";
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

/**
 * SECURITY: every requester field except `email` is typed by an anonymous stranger and never
 * verified. They render ONLY as plain React text children (escaped by default); links are
 * deliberately NOT anchors, so a `javascript:` or look-alike URL cannot be clicked from the
 * admin origin. Do not auto-link, do not use dangerouslySetInnerHTML, do not build an href.
 */
function RequesterDetails({ grant, idPrefix }: { grant: QueueGrant; idPrefix: string }) {
  const headingId = `${idPrefix}-submitted`;
  return (
    <div className="flex flex-col gap-3">
      <dl className="text-sm">
        <dt className="text-xs font-medium text-muted-foreground">Email (verified)</dt>
        <dd className="break-all">{grant.email}</dd>
      </dl>
      <section
        aria-labelledby={headingId}
        className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3"
      >
        <h4 id={headingId} className="text-xs font-medium text-muted-foreground">
          Unauthenticated: as submitted, not verified
        </h4>
        <p className="text-xs text-muted-foreground">Only the email address was verified.</p>
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-xs font-medium text-muted-foreground">Name</dt>
          <dd className="break-words">{grant.name}</dd>
          {grant.organization ? (
            <>
              <dt className="text-xs font-medium text-muted-foreground">Organization</dt>
              <dd className="break-words">{grant.organization}</dd>
            </>
          ) : null}
          {grant.role ? (
            <>
              <dt className="text-xs font-medium text-muted-foreground">Role</dt>
              <dd className="break-words">{grant.role}</dd>
            </>
          ) : null}
          <dt className="text-xs font-medium text-muted-foreground">Category</dt>
          <dd>{grant.category}</dd>
          <dt className="text-xs font-medium text-muted-foreground">Intended use</dt>
          <dd className="break-words whitespace-pre-wrap">{grant.intendedUse}</dd>
          {grant.links.length > 0 ? (
            <>
              <dt className="text-xs font-medium text-muted-foreground">Links</dt>
              <dd>
                <ul className="flex flex-col gap-1">
                  {grant.links.map((link, index) => (
                    <li key={index} className="break-all">
                      {link}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
        </dl>
      </section>
    </div>
  );
}

function QueueRow({
  grant,
  onResult,
}: {
  grant: QueueGrant;
  onResult: (result: QueueResult, row?: Element | null) => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [reviewNote, setReviewNote] = useState("");
  const [rejectionNote, setRejectionNote] = useState("");
  // Set once an action succeeds; a refreshed row arrives as a new `grant` object and clears it.
  const [doneFor, setDoneFor] = useState<QueueGrant | null>(null);
  const idPrefix = useId();
  const rowRef = useRef<HTMLElement>(null);

  // If the refresh never replaces the row, release the lock rather than leave it stuck. The server
  // re-checks every action, so a stale second click is refused there.
  useEffect(() => {
    if (!doneFor) return;
    const timer = setTimeout(() => setDoneFor(null), LOCK_RELEASE_MS);
    return () => clearTimeout(timer);
  }, [doneFor]);

  const done = doneFor === grant;
  const locked = isPending || done;
  const isRenewal = grant.status !== "pending_review";
  const titleId = `${idPrefix}-title`;
  const noteId = `${idPrefix}-note`;
  const rejectionId = `${idPrefix}-rejection`;

  function handleApprove() {
    if (locked) return;
    const row = rowRef.current;
    startTransition(async () => {
      try {
        const result = await approveDatasetGrantAction(grant.id, reviewNote.trim() || undefined);
        if (!result.ok) {
          onResult({ tone: "error", text: `${grant.name}: ${result.error}` }, row);
          // The row may be stale (that is usually why the action refused): show what the server has now.
          router.refresh();
          return;
        }
        if (result.kind === "renewed") {
          onResult(
            { tone: "success", text: `Renewal approved for ${grant.name}. No email is sent.` },
            row,
          );
        } else {
          const outcome = describeMailOutcome(result.mail, "approved");
          onResult(
            {
              tone: outcome.delivered ? "success" : "warning",
              text: `Approved the request from ${grant.name}. ${outcome.text}`,
            },
            row,
          );
        }
        setDoneFor(grant);
        router.refresh();
      } catch {
        onResult({ tone: "error", text: `${grant.name}: ${ACTION_FAILED}` }, row);
      }
    });
  }

  function handleReject() {
    if (locked) return;
    const row = rowRef.current;
    startTransition(async () => {
      try {
        const result = await rejectDatasetGrantAction(grant.id, {
          reviewNote: reviewNote.trim() || undefined,
          rejectionNote: rejectionNote.trim() || undefined,
        });
        if (!result.ok) {
          onResult({ tone: "error", text: `${grant.name}: ${result.error}` }, row);
          // The row may be stale (that is usually why the action refused): show what the server has now.
          router.refresh();
          return;
        }
        const outcome = describeMailOutcome(result.mail, "rejected");
        onResult(
          {
            tone: outcome.delivered ? "success" : "warning",
            text: `Rejected the request from ${grant.name}. ${outcome.text}`,
          },
          row,
        );
        setDoneFor(grant);
        router.refresh();
      } catch {
        onResult({ tone: "error", text: `${grant.name}: ${ACTION_FAILED}` }, row);
      }
    });
  }

  return (
    <article
      ref={rowRef}
      aria-labelledby={titleId}
      aria-busy={isPending || undefined}
      className="flex flex-col gap-4 rounded-lg border border-border p-4"
    >
      <div className="flex flex-col gap-1">
        <h3 id={titleId} className="text-sm font-semibold break-words">
          {isRenewal ? "Renewal request from" : "New request from"} {grant.name}
        </h3>
        {isRenewal ? (
          <>
            {grant.renewalRequestedAt ? (
              <p className="text-xs text-muted-foreground">
                Renewal requested <DateText value={grant.renewalRequestedAt} />
              </p>
            ) : null}
            {!grant.live && grant.expiresAt ? (
              <p className="text-xs font-medium text-destructive">
                Expired <DateText value={grant.expiresAt} />: downloads are paused until you approve
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Requested <DateText value={grant.createdAt} />
          </p>
        )}
      </div>

      <RequesterDetails grant={grant} idPrefix={idPrefix} />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={noteId}>Internal note (optional)</Label>
        <textarea
          id={noteId}
          value={reviewNote}
          onChange={(e) => setReviewNote(e.target.value)}
          aria-describedby={`${noteId}-hint`}
          className={TEXTAREA_CLASS}
        />
        <p id={`${noteId}-hint`} className="text-xs text-muted-foreground">
          Only you see this. It is never emailed.
        </p>
      </div>

      {isRenewal ? null : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={rejectionId}>Note sent to the requester (optional, rejecting only)</Label>
          <textarea
            id={rejectionId}
            value={rejectionNote}
            onChange={(e) => setRejectionNote(e.target.value)}
            aria-describedby={`${rejectionId}-hint`}
            className={TEXTAREA_CLASS}
          />
          <p id={`${rejectionId}-hint`} className="text-xs text-muted-foreground">
            Included in the rejection email.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {isRenewal ? (
          <Button
            size="sm"
            aria-disabled={locked || undefined}
            className={LOCKED_CLASS}
            onClick={handleApprove}
            aria-label={`Approve renewal for ${grant.name}`}
          >
            Approve renewal
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              aria-disabled={locked || undefined}
              className={LOCKED_CLASS}
              onClick={handleApprove}
              aria-label={`Approve request from ${grant.name}`}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              aria-disabled={locked || undefined}
              className={LOCKED_CLASS}
              onClick={handleReject}
              aria-label={`Reject request from ${grant.name}`}
            >
              Reject
            </Button>
          </>
        )}
        {isPending ? <WorkingText /> : null}
      </div>
    </article>
  );
}

export function AccessQueue({ grants }: { grants: QueueGrant[] }) {
  const { state, report, headingRef } = useResultReporter();

  return (
    <section aria-labelledby="review-queue-heading" className="flex flex-col gap-3">
      <h2
        id="review-queue-heading"
        ref={headingRef}
        tabIndex={-1}
        className={`text-lg font-semibold ${FOCUS_HEADING_CLASS}`}
      >
        Review queue <span className="text-muted-foreground">({grants.length})</span>
      </h2>
      <ResultRegion result={state.result} seq={state.seq} />
      {grants.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Nothing is waiting for review.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {grants.map((grant) => (
            <QueueRow key={grant.id} grant={grant} onResult={report} />
          ))}
        </div>
      )}
    </section>
  );
}
