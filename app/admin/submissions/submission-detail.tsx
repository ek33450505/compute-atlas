import { getFacilityById } from "@/lib/data";
import type { SubmissionRow } from "@/lib/db/schema";
import { computeDocDiff } from "@/lib/doc-diff";
import { formatStatusLabel } from "@/lib/format";
import { STATUS_ORDER, type Status } from "@/lib/status";
import { DocDiffView, stringifyValue } from "@/components/admin/doc-diff";

/** Fields to skip when rendering a create-kind summary — noisy/internal. */
const CREATE_SUMMARY_KEYS = [
  "name",
  "operator",
  "status",
  "confidence",
  "facilityType",
  "location",
  "capacityMw",
  "sources",
] as const;

/**
 * Renders a shallow, top-level field-by-field summary of a create-kind
 * submission's payload. `payload` is `Record<string, unknown>` (validated
 * only at the envelope level by `submissionInputSchema` — full
 * `facilitySchema` validation happens at approve time), so we render the
 * fields most useful for review first, then any remaining top-level keys.
 */
function CreateSummary({ payload }: { payload: Record<string, unknown> }) {
  const knownKeys = CREATE_SUMMARY_KEYS.filter((key) => key in payload);
  const otherKeys = Object.keys(payload).filter(
    (key) => !CREATE_SUMMARY_KEYS.includes(key as (typeof CREATE_SUMMARY_KEYS)[number])
  );

  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {[...knownKeys, ...otherKeys].map((key) => (
        <div key={key} className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium text-muted-foreground">{key}</dt>
          <dd className="text-sm break-words whitespace-pre-wrap">
            {stringifyValue(payload[key])}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Renders a SHALLOW top-level before/after diff between the live facility
 * doc and an update-kind submission's patch. `updateFacility`'s own merge
 * (`{...existingRow.doc, ...patch, id}`) is shallow top-level, so a shallow
 * diff view is the correct fidelity here — do not deep-diff nested objects.
 *
 * Delegates to the shared `computeDocDiff` (`lib/doc-diff.ts`, also used by
 * the `facility_history` write path) and the shared `DocDiffView` render
 * component (`components/admin/doc-diff.tsx`). `computeDocDiff(current,
 * {...current, ...patch})` reproduces this component's prior inline
 * behavior exactly: spreading `patch` over `current` then diffing against
 * `current` only ever flags `patch`'s own changed keys.
 */
function UpdateDiff({
  current,
  patch,
}: {
  current: Record<string, unknown> | undefined;
  patch: Record<string, unknown>;
}) {
  const currentDoc = current ?? null;
  const entries = computeDocDiff(currentDoc, { ...currentDoc, ...patch });
  return <DocDiffView entries={entries} />;
}

/**
 * Renders an unrecognized/unvalidated status value as its human-readable
 * label when it's a known `Status`, otherwise falls back to the raw string.
 * A status_update submission's payload is only envelope-validated
 * (`submissionInputSchema`) before approval — `statusUpdateIntentSchema`
 * validation happens server-side at approve time — so the `status` value
 * shown here could in principle be anything.
 */
function formatLooseStatus(value: unknown): string {
  if (typeof value !== "string") return stringifyValue(value);
  return (STATUS_ORDER as readonly string[]).includes(value)
    ? formatStatusLabel(value as Status)
    : value;
}

interface StatusUpdateSource {
  label?: unknown;
  url?: unknown;
}

/**
 * Renders a status_update submission's transition intent against the live
 * facility. Unlike `update`, a status_update payload is NOT a doc patch —
 * it's a transition instruction (`{ status, date, note?, sources }`)
 * applied append-only by `writeStatusUpdate`/`applyStatusUpdate`
 * (lib/status-update.ts, lib/facility-write.ts): the listed source(s) are
 * APPENDED to the facility's existing `sources`, never replacing them, and
 * a new `statusHistory` entry is appended. A shallow `UpdateDiff` would
 * mis-render this (it would show `sources` being replaced by the intent's
 * one source), so this gets a dedicated view instead.
 *
 * `intent` stays `Record<string, unknown>` (matching `UpdateDiff`'s
 * loosely-typed `patch` param) since it's only envelope-validated before
 * approval — read every field defensively.
 */
function StatusUpdateSummary({
  current,
  intent,
}: {
  current: Record<string, unknown>;
  intent: Record<string, unknown>;
}) {
  const fromStatus = formatLooseStatus(current.status);
  const toStatus = formatLooseStatus(intent.status);
  const date = typeof intent.date === "string" ? intent.date : undefined;
  const note = typeof intent.note === "string" ? intent.note : undefined;
  const sources = Array.isArray(intent.sources) ? intent.sources : [];

  return (
    <dl className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <dt className="text-xs font-medium text-muted-foreground">Status</dt>
        <dd className="text-sm">
          {fromStatus} <span aria-hidden="true">→</span>
          <span className="sr-only"> changing to </span> {toStatus}
        </dd>
      </div>
      {date ? (
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium text-muted-foreground">Effective date</dt>
          <dd className="text-sm">{date}</dd>
        </div>
      ) : null}
      {note ? (
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-medium text-muted-foreground">Note</dt>
          <dd className="text-sm break-words whitespace-pre-wrap">{note}</dd>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <dt className="text-xs font-medium text-muted-foreground">
          New source{sources.length === 1 ? "" : "s"} (appended — existing sources are kept)
        </dt>
        <dd>
          {sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sources on this submission.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {sources.map((source, i) => {
                const s = source as StatusUpdateSource;
                const label = typeof s.label === "string" && s.label.length > 0 ? s.label : "Source";
                const url = typeof s.url === "string" ? s.url : undefined;
                return (
                  <li key={i} className="text-sm">
                    <span className="font-medium">{label}</span>
                    {url ? <span className="text-muted-foreground"> — {url}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </dd>
      </div>
    </dl>
  );
}

export async function SubmissionDetail({ submission }: { submission: SubmissionRow }) {
  const payload = submission.payload as Record<string, unknown>;

  if (submission.kind === "create") {
    return <CreateSummary payload={payload} />;
  }

  // kind === "update" | "status_update" — both require the live facility.
  // targetFacilityId is required for both by submissionInputSchema, but the
  // field is nullable in the DB type, so guard defensively.
  const targetFacility = submission.targetFacilityId
    ? await getFacilityById(submission.targetFacilityId)
    : undefined;

  if (!targetFacility) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-destructive">
          Target facility &ldquo;{submission.targetFacilityId}&rdquo; no longer exists — showing
          the raw patch instead of a diff.
        </p>
        <CreateSummary payload={payload} />
      </div>
    );
  }

  const currentDoc = targetFacility as unknown as Record<string, unknown>;

  if (submission.kind === "status_update") {
    return <StatusUpdateSummary current={currentDoc} intent={payload} />;
  }

  return <UpdateDiff current={currentDoc} patch={payload} />;
}
