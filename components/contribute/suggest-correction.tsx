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
import {
  CORRECTABLE_FIELD_META,
  type CorrectableDisplayValues,
  type CorrectableKey,
} from "@/lib/contribute-fields";
import {
  correctionNumberHint,
  isHttpUrl,
  normalizeSourceUrl,
  parseCorrectionNumber,
} from "@/lib/correction-input";
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
const STATE_ITEMS = STATE_OPTIONS.map((s) => ({ value: s.code, label: s.name }));

// ---------------------------------------------------------------------------
// Intent framing — a gap prompt ("Know the capacity?") isn't reporting an
// error, so it asks "What are you adding?" rather than "What's wrong?".
// ---------------------------------------------------------------------------

type SuggestCorrectionIntent = "add" | "correct";

const NOT_RECORDED = "not recorded";

const INTENT_COPY = {
  correct: { title: "Suggest a correction", fieldLabel: "What\u2019s wrong?" },
  add: { title: "Add missing information", fieldLabel: "What are you adding?" },
} as const satisfies Record<SuggestCorrectionIntent, { title: string; fieldLabel: string }>;

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
  let value: string | number = state.value;
  if (def?.valueKind === "number") {
    const parsed = parseCorrectionNumber(state.value, state.field);
    // `validateCorrection` gates the submit, so this is unreachable from the
    // dialog. Guessing (Number("1e3") is 1000) would post a wrong figure.
    if (!parsed.ok) throw new Error(`Cannot build a ${state.field} correction from "${state.value}"`);
    value = parsed.value;
  }

  const payload: Record<string, unknown> = {
    kind: "correction",
    website: state.website,
    targetFacilityId: facilityId,
    field: state.field,
    value,
    sourceUrl: normalizeSourceUrl(state.sourceUrl),
  };

  if (state.attribution.trim()) payload.attribution = state.attribution.trim();
  if (state.note.trim()) payload.note = state.note.trim();

  return payload;
}

const SOURCE_REQUIRED = "Add a link to a public source.";
const SOURCE_NOT_HTTP = "Paste the full link, starting with https://";
// Zod's bare message for a string that doesn't parse as a URL (zod 4.6).
const ZOD_INVALID_URL = "Invalid URL";

/**
 * Field errors to show BEFORE posting, keyed like the server's issues
 * (`value`, `sourceUrl`). Empty means the form can be submitted. Mirrors the
 * server's rules (lib/contribute.ts) closely enough that a typo is caught here
 * with a friendly message rather than as a 400.
 */
export function validateCorrection(state: CorrectionFormState): FieldIssues {
  const def = CORRECTABLE_FIELD_META.find((m) => m.key === state.field);
  const issues: FieldIssues = {};

  if (def?.valueKind === "number") {
    const parsed = parseCorrectionNumber(state.value, state.field);
    if (!parsed.ok) issues["value"] = parsed.error;
  } else if (def?.valueKind === "enum") {
    if (!def.enumValues?.includes(state.value)) issues["value"] = "Select a value.";
  } else if (def?.valueKind === "state") {
    if (!state.value) issues["value"] = "Select a state.";
  } else if (state.value.trim() === "") {
    issues["value"] = "Enter a new value.";
  }

  const source = normalizeSourceUrl(state.sourceUrl);
  if (source === "") issues["sourceUrl"] = SOURCE_REQUIRED;
  else if (!isHttpUrl(source)) issues["sourceUrl"] = SOURCE_NOT_HTTP;

  return issues;
}

/**
 * The "Currently: …" text for the targeted field, or null for no line at all.
 * With facility data, a field it lacks is "not recorded". Without it, only a
 * gap prompt (intent "add") still on its own default field is known to be
 * empty; a switched-to field could hold anything, so it says nothing.
 *
 * That fallback is only true because every FieldGapPrompt call site renders
 * for an ABSENT field. A gap gate broader than its field would print a false
 * "not recorded" — pass `currentValues` there instead.
 */
export function currentValueFor({
  currentValues,
  intent,
  field,
  defaultField,
}: {
  currentValues: CorrectableDisplayValues | undefined;
  intent: SuggestCorrectionIntent;
  field: CorrectableKey;
  defaultField: CorrectableKey | undefined;
}): string | null {
  if (currentValues) return currentValues[field] ?? NOT_RECORDED;
  if (intent === "add" && field === defaultField) return NOT_RECORDED;
  return null;
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
  triggerLabel,
  triggerClassName,
  triggerAriaLabel,
  showIntro = true,
  intent = "correct",
  currentValues,
}: {
  facilityId: string;
  facilityName: string;
  /** Pre-selects "What's wrong?" to this field instead of the first option —
   * used by FieldGapPrompt to deep-link the dialog at a specific gap. */
  defaultField?: CorrectableKey;
  /**
   * Custom trigger label. Passing this switches the trigger from the
   * default full-size "Suggest a correction" `<Button>` to a quiet
   * `<button className={triggerClassName}>`. IMPORTANT: the label is always
   * passed as `DialogTrigger`'s children, never baked into the element
   * handed to Base UI's `render` prop — `render` does NOT server-render the
   * children of the element it's given, so a label embedded there is
   * missing from the served HTML and produces a hydration mismatch (the bug
   * this prop shape replaces — see git history for the empty
   * `<button></button>` SSR defect).
   */
  triggerLabel?: React.ReactNode;
  /** Classes for the custom trigger's `<button>` element. Ignored when
   * `triggerLabel` is omitted (the default Button trigger keeps its own
   * "Suggest a correction" styling). */
  triggerClassName?: string;
  /** Accessible-name override for the custom trigger, e.g. distinguishing
   * ConfirmFactPrompt's visible "No" from its accessible "No, {label} needs
   * a correction". */
  triggerAriaLabel?: string;
  /** Gates the "Compute Atlas is meant to be corrected..." intro paragraph —
   * off by default for compact/inline instances (masthead strip, gap prompts). */
  showIntro?: boolean;
  /** Dialog framing. `"correct"` (default) is for reporting an error;
   * `"add"` is for filling a known gap, where "What's wrong?" misleads. */
  intent?: SuggestCorrectionIntent;
  /** The facility's current value per field (see `correctableDisplayValues`),
   * shown as "Currently: …" under the field select. When omitted, only an
   * `intent="add"` dialog still on its `defaultField` says "not recorded" — a
   * gap prompt only opens on an empty field. */
  currentValues?: CorrectableDisplayValues;
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
  const copy = INTENT_COPY[intent];
  const currentValue = currentValueFor({
    currentValues,
    intent,
    field: state.field,
    defaultField,
  });
  // Options for an enum-kind field come from THAT field's own values — the
  // server validates against `def.enumValues` (lib/contribute.ts), so any other
  // list (e.g. the status values) can never be submitted successfully.
  const enumItems = (def.enumValues ?? []).map((v) => ({ value: v, label: def.enumLabels?.[v] ?? v }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    // Catch what the server would reject, with friendlier copy, and put focus
    // on the first control to fix (the value comes before the source).
    const clientIssues = validateCorrection(state);
    const firstInvalidId = clientIssues["value"]
      ? valueId
      : clientIssues["sourceUrl"]
        ? sourceId
        : null;
    if (firstInvalidId) {
      setErrors(clientIssues);
      setFormError("Please fix the errors below.");
      // By id, not a ref: the value control is an Input or a Select trigger
      // depending on the field, so one lookup beats a ref per branch.
      document.getElementById(firstInvalidId)?.focus();
      return;
    }

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
        const issues = issuesToFieldMap(body.issues);
        if (issues["sourceUrl"] === ZOD_INVALID_URL) issues["sourceUrl"] = SOURCE_NOT_HTTP;
        setErrors(issues);
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
  const currentId = `${uid}-correction-current`;
  const valueId = `${uid}-correction-value`;
  const valueHintId = `${uid}-correction-value-hint`;
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

  const numberHint = def.valueKind === "number" ? correctionNumberHint(state.field) : undefined;
  const valueDescribedBy = [numberHint ? valueHintId : null, errors["value"] ? valueErrorId : null]
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
          render={
            triggerLabel !== undefined ? (
              <button
                type="button"
                className={triggerClassName}
                aria-label={triggerAriaLabel}
              />
            ) : (
              <Button variant="outline" className="min-h-11" />
            )
          }
        >
          {triggerLabel !== undefined ? triggerLabel : "Suggest a correction"}
        </DialogTrigger>
        <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{facilityName}</DialogDescription>
          </DialogHeader>

          {/* Only the body scrolls, so the header and the shared close button stay
              pinned on short screens. `p-1` makes room for the focus rings that
              overflow would otherwise clip; `-m-1` cancels that padding so the
              body column still lines up with the header. */}
          <div className="-m-1 min-h-0 overflow-y-auto p-1">
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
                  <Label htmlFor={fieldId}>{copy.fieldLabel}</Label>
                  <Select
                    items={CORRECTABLE_FIELD_ITEMS}
                    value={state.field}
                    onValueChange={(v) => {
                      if (v === null) return;
                      setState((prev) => ({ ...prev, field: v as CorrectableKey, value: "" }));
                    }}
                  >
                    <SelectTrigger
                      id={fieldId}
                      className="w-full"
                      aria-describedby={currentValue !== null ? currentId : undefined}
                    >
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
                  {currentValue !== null ? (
                    <p id={currentId} className="text-xs text-muted-foreground">
                      Currently: {currentValue}
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={valueId}>
                    New value
                    <span aria-hidden="true" className="text-destructive"> *</span>
                  </Label>
                  {/* maxLength 200 is validateFieldValue's 1-200 text rule in
                      lib/contribute.ts; the 2000 in correctionSchema is only the outer cap. */}
                  {def.valueKind === "text" && (
                    <Input
                      id={valueId}
                      name="correction-value"
                      type="text"
                      maxLength={200}
                      value={state.value}
                      onChange={(e) => setState((prev) => ({ ...prev, value: e.target.value }))}
                      required
                      aria-required="true"
                      aria-invalid={errors["value"] ? true : undefined}
                      aria-describedby={valueDescribedBy || undefined}
                    />
                  )}
                  {def.valueKind === "number" && (
                    <>
                      {/* type="text": people type "1.2 GW" or "$12.5M", which a
                          number input would refuse; parseCorrectionNumber reads it. */}
                      <Input
                        id={valueId}
                        name="correction-value"
                        type="text"
                        inputMode="decimal"
                        value={state.value}
                        onChange={(e) => setState((prev) => ({ ...prev, value: e.target.value }))}
                        required
                        aria-required="true"
                        aria-invalid={errors["value"] ? true : undefined}
                        aria-describedby={valueDescribedBy || undefined}
                      />
                      {numberHint ? (
                        <p id={valueHintId} className="text-xs text-muted-foreground">
                          {numberHint}
                        </p>
                      ) : null}
                    </>
                  )}
                  {def.valueKind === "enum" && (
                    <Select
                      items={enumItems}
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
                        aria-describedby={valueDescribedBy || undefined}
                      >
                        <SelectValue placeholder="Select a value" />
                      </SelectTrigger>
                      <SelectContent>
                        {enumItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
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
                        aria-describedby={valueDescribedBy || undefined}
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
                    onBlur={() =>
                      // Show the https:// that was added, so what is sent is what is seen.
                      setState((prev) => {
                        const sourceUrl = normalizeSourceUrl(prev.sourceUrl);
                        return sourceUrl === prev.sourceUrl ? prev : { ...prev, sourceUrl };
                      })
                    }
                    required
                    aria-required="true"
                    aria-invalid={errors["sourceUrl"] ? true : undefined}
                    aria-describedby={sourceDescribedBy || undefined}
                  />
                  <p id={sourceHintId} className="text-xs text-muted-foreground">
                    Where did you see it? A news story, permit, filing, or company page.
                  </p>
                  <FieldError id={sourceErrorId} message={errors["sourceUrl"]} />
                </div>

                <details>
                  <summary className="cursor-pointer rounded-sm py-3 text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                    Add a note or credit (optional)
                  </summary>
                  <div className="mt-4 flex flex-col gap-4">
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
                  </div>
                </details>

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
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
