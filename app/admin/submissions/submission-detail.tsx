import { getFacilityById } from "@/lib/data";
import type { SubmissionRow } from "@/lib/db/schema";
import { Badge } from "@/components/ui/badge";

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

function stringifyValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

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
 */
function UpdateDiff({
  current,
  patch,
}: {
  current: Record<string, unknown> | undefined;
  patch: Record<string, unknown>;
}) {
  const changedKeys = Object.keys(patch).filter((key) => {
    const before = current?.[key];
    const after = patch[key];
    return JSON.stringify(before) !== JSON.stringify(after);
  });

  if (changedKeys.length === 0) {
    return <p className="text-sm text-muted-foreground">No field-level changes detected.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {changedKeys.map((key) => (
        <div key={key} className="rounded-md border border-border p-3">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">{key}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <Badge variant="outline" className="mb-1">
                Before
              </Badge>
              <p className="text-sm break-words whitespace-pre-wrap text-muted-foreground">
                {stringifyValue(current?.[key])}
              </p>
            </div>
            <div>
              <Badge variant="secondary" className="mb-1">
                After
              </Badge>
              <p className="text-sm break-words whitespace-pre-wrap">{stringifyValue(patch[key])}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export async function SubmissionDetail({ submission }: { submission: SubmissionRow }) {
  const payload = submission.payload as Record<string, unknown>;

  if (submission.kind === "create") {
    return <CreateSummary payload={payload} />;
  }

  // kind === "update" — fetch the live facility for the diff. targetFacilityId
  // is required for update-kind rows by submissionInputSchema, but the field
  // is nullable in the DB type, so guard defensively.
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

  return (
    <UpdateDiff current={targetFacility as unknown as Record<string, unknown>} patch={payload} />
  );
}
