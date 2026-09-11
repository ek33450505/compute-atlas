"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { issuesToFieldMap, FieldError, type FieldIssues } from "@/components/contribute/field-primitives";
import { CORRECTABLE_FIELD_META, type CorrectableKey } from "@/lib/contribute-fields";
import { STATUS_ORDER, STATUS_META } from "@/lib/status";
import { US_STATE_NAMES } from "@/lib/us-states";

// ---------------------------------------------------------------------------
// US state options (sorted by name) — matches contribute-facility-form.tsx
// ---------------------------------------------------------------------------

const STATE_OPTIONS = Object.entries(US_STATE_NAMES)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

// `items` for each <Select> — Base UI resolves the trigger's displayed label
// from this, not from the rendered <SelectItem> children (mirrors
// contribute-facility-form.tsx's fix for the same quirk). Each is derived
// from the same source the <SelectItem>s below map over.
const CORRECTABLE_FIELD_ITEMS = CORRECTABLE_FIELD_META.map((m) => ({
  value: m.key,
  label: m.label,
}));
const STATUS_ITEMS = STATUS_ORDER.map((s) => ({ value: s, label: STATUS_META[s].label }));
const STATE_ITEMS = STATE_OPTIONS.map((s) => ({ value: s.code, label: s.name }));

// ---------------------------------------------------------------------------
// Payload building (pure helper — kept separate so it's unit-testable
// without driving the Base UI Dialog/Select stack in jsdom)
// ---------------------------------------------------------------------------

export interface CorrectionFormState {
  field: CorrectableKey;
  value: string;
  sourceUrl: string;
  attribution: string;
  note: string;
  /** Honeypot — real submitters never see or fill this. */
  website: string;
}

export function buildCorrectionPayload(
  facilityId: string,
  state: CorrectionFormState
): Record<string, unknown> {
  const def = CORRECTABLE_FIELD_META.find((m) => m.key === state.field);
  const value = def?.valueKind === "number" ? Number(state.value) : state.value;

  const payload: Record<string, unknown> = {
    kind: "correction",
    website: state.website,
    targetFacilityId: facilityId,
    field: state.field,
    value,
    sourceUrl: state.sourceUrl.trim(),
  };

  if (state.attribution.trim()) payload.attribution = state.attribution.trim();
  if (state.note.trim()) payload.note = state.note.trim();

  return payload;
}

// ---------------------------------------------------------------------------
// Honeypot (hidden from humans, off-screen not display:none) — copied from
// contribute-facility-form.tsx's HoneypotField pattern. `id` is required
// (not defaulted) since every instance on a page needs a useId()-derived one.
// ---------------------------------------------------------------------------

function HoneypotField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
      <label htmlFor={id}>Website</label>
      <input
        id={id}
        name="website"
        type="text"
        tabIndex={-1}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/** Empty-state builder — a function (not a module-level constant) because the
 * default targeted field now depends on the `defaultField` prop. */
function emptyState(defaultField?: CorrectableKey): CorrectionFormState {
  return {
    field: defaultField ?? CORRECTABLE_FIELD_META[0].key,
    value: "",
    sourceUrl: "",
    attribution: "",
    note: "",
    website: "",
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type SubmitOutcome = "idle" | "success";

export function SuggestCorrection({
  facilityId,
  facilityName,
  defaultField,
  trigger,
  showIntro = true,
}: {
  facilityId: string;
  facilityName: string;
  /** Pre-selects "What's wrong?" to this field instead of the first option —
   * used by FieldGapPrompt to deep-link the dialog at a specific gap. */
  defaultField?: CorrectableKey;
  /** Custom dialog trigger, forwarded to the underlying Base UI `render` prop
   * (which requires a single element, not arbitrary ReactNode). Defaults to
   * the full-size "Suggest a correction" button used by the end-of-page CTA. */
  trigger?: React.ReactElement;
  /** Gates the "Compute Atlas is meant to be corrected..." intro paragraph —
   * off by default for compact/inline instances (masthead strip, gap prompts). */
  showIntro?: boolean;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<CorrectionFormState>(() => emptyState(defaultField));
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [errors, setErrors] = useState<FieldIssues>({});
  const [outcome, setOutcome] = useState<SubmitOutcome>("idle");
  const successRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (outcome === "success") successRef.current?.focus();
  }, [outcome]);

  function resetForm() {
    setState(emptyState(defaultField));
    setFormError(undefined);
    setErrors({});
    setOutcome("idle");
  }

  const def = CORRECTABLE_FIELD_META.find((m) => m.key === state.field)!;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFormError(undefined);
    setErrors({});
    setSubmitting(true);

    try {
      const res = await fetch("/api/contribute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCorrectionPayload(facilityId, state)),
      });

      if (res.status === 201) {
        setOutcome("success");
        return;
      }

      let json: unknown = undefined;
      try {
        json = await res.json();
      } catch {
        // no body / non-JSON response — fall through to generic messaging below
      }

      if ((res.status === 400 || res.status === 404 || res.status === 429) && json && typeof json === "object") {
        const body = json as { error?: string; issues?: unknown };
        setErrors(issuesToFieldMap(body.issues));
        setFormError(body.error ?? "Please fix the errors below.");
        return;
      }

      setFormError("Something went wrong. Please try again.");
    } catch {
      setFormError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const fieldId = `${uid}-correction-field`;
  const valueId = `${uid}-correction-value`;
  const sourceId = `${uid}-correction-source`;
  const sourceHintId = `${uid}-correction-source-hint`;
  const attributionId = `${uid}-correction-attribution`;
  const attributionHintId = `${uid}-correction-attribution-hint`;
  const noteId = `${uid}-correction-note`;
  const websiteId = `${uid}-correction-website`;
  const valueErrorId = `${uid}-correction-value-error`;
  const sourceErrorId = `${uid}-correction-source-error`;

  const sourceDescribedBy = [sourceHintId, errors["sourceUrl"] ? sourceErrorId : null]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="space-y-2">
      {showIntro ? (
        <p className="text-sm text-muted-foreground">
          Compute Atlas is meant to be corrected. If you have better,
          source-backed data on this facility, suggest a change — it&rsquo;s
          reviewed before anything updates.
        </p>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) resetForm();
        }}
      >
        <DialogTrigger
          render={trigger ?? <Button variant="outline" className="min-h-11" />}
        >
          {trigger ? undefined : "Suggest a correction"}
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Suggest a correction</DialogTitle>
            <DialogDescription>{facilityName}</DialogDescription>
          </DialogHeader>

          {outcome === "success" ? (
            <div className="flex flex-col items-start gap-4">
              <p
                ref={successRef}
                role="alert"
                tabIndex={-1}
                className="text-base text-foreground outline-none"
              >
                Thanks — your correction is in the review queue.
              </p>
              <p className="text-sm text-muted-foreground">
                Most submissions are reviewed within about a week. If it
                checks out, it will appear on the map and on the{" "}
                <Link
                  href="/activity"
                  className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                >
                  public activity feed
                </Link>
                . Submissions are anonymous, so there&rsquo;s no status to
                track this one.
              </p>
              <Button
                type="button"
                onClick={() => {
                  setOpen(false);
                  resetForm();
                }}
              >
                Done
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
              <HoneypotField
                id={websiteId}
                value={state.website}
                onChange={(v) => setState((prev) => ({ ...prev, website: v }))}
              />

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={fieldId}>What&rsquo;s wrong?</Label>
                <Select
                  items={CORRECTABLE_FIELD_ITEMS}
                  value={state.field}
                  onValueChange={(v) => {
                    if (v === null) return;
                    setState((prev) => ({ ...prev, field: v as CorrectableKey, value: "" }));
                  }}
                >
                  <SelectTrigger id={fieldId} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CORRECTABLE_FIELD_META.map((m) => (
                      <SelectItem key={m.key} value={m.key}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={valueId}>
                  New value
                  <span aria-hidden="true" className="text-destructive"> *</span>
                </Label>
                {def.valueKind === "text" && (
                  <Input
                    id={valueId}
                    name="correction-value"
                    type="text"
                    value={state.value}
                    onChange={(e) => setState((prev) => ({ ...prev, value: e.target.value }))}
                    required
                    aria-required="true"
                    aria-invalid={errors["value"] ? true : undefined}
                    aria-describedby={errors["value"] ? valueErrorId : undefined}
                  />
                )}
                {def.valueKind === "number" && (
                  <Input
                    id={valueId}
                    name="correction-value"
                    type="number"
                    step="any"
                    min="0"
                    value={state.value}
                    onChange={(e) => setState((prev) => ({ ...prev, value: e.target.value }))}
                    required
                    aria-required="true"
                    aria-invalid={errors["value"] ? true : undefined}
                    aria-describedby={errors["value"] ? valueErrorId : undefined}
                  />
                )}
                {def.valueKind === "enum" && (
                  <Select
                    items={STATUS_ITEMS}
                    value={state.value || null}
                    onValueChange={(v) => {
                      if (v === null) return;
                      setState((prev) => ({ ...prev, value: v }));
                    }}
                  >
                    <SelectTrigger
                      id={valueId}
                      className="w-full"
                      aria-invalid={errors["value"] ? true : undefined}
                      aria-describedby={errors["value"] ? valueErrorId : undefined}
                    >
                      <SelectValue placeholder="Select a value" />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_ORDER.map((s) => (
                        <SelectItem key={s} value={s}>
                          {STATUS_META[s].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                {def.valueKind === "state" && (
                  <Select
                    items={STATE_ITEMS}
                    value={state.value || null}
                    onValueChange={(v) => {
                      if (v === null) return;
                      setState((prev) => ({ ...prev, value: v }));
                    }}
                  >
                    <SelectTrigger
                      id={valueId}
                      className="w-full"
                      aria-invalid={errors["value"] ? true : undefined}
                      aria-describedby={errors["value"] ? valueErrorId : undefined}
                    >
                      <SelectValue placeholder="Select a state" />
                    </SelectTrigger>
                    <SelectContent>
                      {STATE_OPTIONS.map((s) => (
                        <SelectItem key={s.code} value={s.code}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <FieldError id={valueErrorId} message={errors["value"]} />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={sourceId}>
                  Source URL
                  <span aria-hidden="true" className="text-destructive"> *</span>
                </Label>
                <Input
                  id={sourceId}
                  name="correction-source"
                  type="url"
                  value={state.sourceUrl}
                  onChange={(e) => setState((prev) => ({ ...prev, sourceUrl: e.target.value }))}
                  required
                  aria-required="true"
                  aria-invalid={errors["sourceUrl"] ? true : undefined}
                  aria-describedby={sourceDescribedBy || undefined}
                />
                <p id={sourceHintId} className="text-xs text-muted-foreground">
                  A public link that backs up this change.
                </p>
                <FieldError id={sourceErrorId} message={errors["sourceUrl"]} />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={attributionId}>Your name or handle (optional)</Label>
                <Input
                  id={attributionId}
                  name="correction-attribution"
                  type="text"
                  value={state.attribution}
                  onChange={(e) => setState((prev) => ({ ...prev, attribution: e.target.value }))}
                  maxLength={40}
                  aria-describedby={attributionHintId}
                />
                <p id={attributionHintId} className="text-xs text-muted-foreground">
                  Credited on the public activity feed. Leave blank to stay anonymous — no email addresses.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor={noteId}>Note (optional)</Label>
                <textarea
                  id={noteId}
                  name="correction-note"
                  value={state.note}
                  onChange={(e) => setState((prev) => ({ ...prev, note: e.target.value }))}
                  rows={3}
                  maxLength={2000}
                  className="rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20"
                />
              </div>

              {formError ? (
                <p role="alert" className="text-sm text-destructive">
                  {formError}
                </p>
              ) : null}

              <div className="flex justify-end">
                <Button type="submit" className="min-h-11" disabled={submitting}>
                  {submitting ? "Submitting…" : "Submit correction"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
