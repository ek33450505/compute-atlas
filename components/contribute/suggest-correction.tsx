"use client";

import { useEffect, useRef, useState } from "react";

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
import { CORRECTABLE_FIELD_META, type CorrectableKey } from "@/lib/contribute-fields";
import { STATUS_ORDER, STATUS_META } from "@/lib/status";
import { US_STATE_NAMES } from "@/lib/us-states";

// ---------------------------------------------------------------------------
// US state options (sorted by name) — matches contribute-facility-form.tsx
// ---------------------------------------------------------------------------

const STATE_OPTIONS = Object.entries(US_STATE_NAMES)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

// ---------------------------------------------------------------------------
// Payload building (pure helper — kept separate so it's unit-testable
// without driving the Base UI Dialog/Select stack in jsdom)
// ---------------------------------------------------------------------------

export interface CorrectionFormState {
  field: CorrectableKey;
  value: string;
  sourceUrl: string;
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

  if (state.note.trim()) payload.note = state.note.trim();

  return payload;
}

// ---------------------------------------------------------------------------
// Field-level error surfacing — the server validates the merged facility, so
// issue paths may be nested. We don't map per-field; just surface the top
// `error` plus the first issue message at the form level.
// ---------------------------------------------------------------------------

interface CorrectionIssue {
  path: (string | number)[];
  message: string;
}

function firstIssueMessage(issues: unknown): string | undefined {
  if (!Array.isArray(issues) || issues.length === 0) return undefined;
  const first = issues[0] as CorrectionIssue | undefined;
  return first && typeof first.message === "string" ? first.message : undefined;
}

// ---------------------------------------------------------------------------
// Honeypot (hidden from humans, off-screen not display:none) — copied from
// contribute-facility-form.tsx's HoneypotField pattern.
// ---------------------------------------------------------------------------

function HoneypotField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
      <label htmlFor="correction-website">Website</label>
      <input
        id="correction-website"
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const EMPTY_STATE: CorrectionFormState = {
  field: CORRECTABLE_FIELD_META[0].key,
  value: "",
  sourceUrl: "",
  note: "",
  website: "",
};

type SubmitOutcome = "idle" | "success";

export function SuggestCorrection({
  facilityId,
  facilityName,
}: {
  facilityId: string;
  facilityName: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<CorrectionFormState>(EMPTY_STATE);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [outcome, setOutcome] = useState<SubmitOutcome>("idle");
  const successRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (outcome === "success") successRef.current?.focus();
  }, [outcome]);

  function resetForm() {
    setState(EMPTY_STATE);
    setFormError(undefined);
    setOutcome("idle");
  }

  const def = CORRECTABLE_FIELD_META.find((m) => m.key === state.field)!;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFormError(undefined);
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
        const detail = firstIssueMessage(body.issues);
        setFormError([body.error, detail].filter(Boolean).join(" — ") || "Something went wrong. Please try again.");
        return;
      }

      setFormError("Something went wrong. Please try again.");
    } catch {
      setFormError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Compute Atlas is meant to be corrected. If you have better,
        source-backed data on this facility, suggest a change — it&rsquo;s
        reviewed before anything updates.
      </p>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) resetForm();
        }}
      >
        <DialogTrigger render={<Button variant="outline" className="min-h-11" />}>
          Suggest a correction
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
                Submissions are anonymous, so there&rsquo;s no way to track
                this one&rsquo;s status. If it checks out, it&rsquo;ll appear
                on the map after review.
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
                value={state.website}
                onChange={(v) => setState((prev) => ({ ...prev, website: v }))}
              />

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="correction-field">What&rsquo;s wrong?</Label>
                <Select
                  value={state.field}
                  onValueChange={(v) => {
                    if (v === null) return;
                    setState((prev) => ({ ...prev, field: v as CorrectableKey, value: "" }));
                  }}
                >
                  <SelectTrigger id="correction-field" className="w-full">
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
                <Label htmlFor="correction-value">New value</Label>
                {def.valueKind === "text" && (
                  <Input
                    id="correction-value"
                    name="correction-value"
                    type="text"
                    value={state.value}
                    onChange={(e) => setState((prev) => ({ ...prev, value: e.target.value }))}
                    required
                  />
                )}
                {def.valueKind === "number" && (
                  <Input
                    id="correction-value"
                    name="correction-value"
                    type="number"
                    step="any"
                    min="0"
                    value={state.value}
                    onChange={(e) => setState((prev) => ({ ...prev, value: e.target.value }))}
                    required
                  />
                )}
                {def.valueKind === "enum" && (
                  <Select
                    value={state.value || null}
                    onValueChange={(v) => {
                      if (v === null) return;
                      setState((prev) => ({ ...prev, value: v }));
                    }}
                  >
                    <SelectTrigger id="correction-value" className="w-full">
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
                    value={state.value || null}
                    onValueChange={(v) => {
                      if (v === null) return;
                      setState((prev) => ({ ...prev, value: v }));
                    }}
                  >
                    <SelectTrigger id="correction-value" className="w-full">
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
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="correction-source">
                  Source URL
                  <span aria-hidden="true" className="text-destructive"> *</span>
                </Label>
                <Input
                  id="correction-source"
                  name="correction-source"
                  type="url"
                  value={state.sourceUrl}
                  onChange={(e) => setState((prev) => ({ ...prev, sourceUrl: e.target.value }))}
                  required
                  aria-describedby="correction-source-hint"
                />
                <p id="correction-source-hint" className="text-xs text-muted-foreground">
                  A public link that backs up this change.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="correction-note">Note (optional)</Label>
                <textarea
                  id="correction-note"
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
