"use client";

import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FACILITY_TYPE_ORDER, FACILITY_TYPE_META, type FacilityType } from "@/lib/facility-type";
import { STATUS_ORDER, STATUS_META, type Status } from "@/lib/status";
import { US_STATE_NAMES } from "@/lib/us-states";

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface ContributeFormState {
  name: string;
  operator: string;
  state: string;
  facilityType: FacilityType;
  status: Status;
  lat: string;
  lon: string;
  city: string;
  capacityOperationalMw: string;
  capacityPlannedMw: string;
  sourceUrl: string;
  sourceLabel: string;
  note: string;
  /** Honeypot — real submitters never see or fill this. */
  website: string;
}

const EMPTY_STATE: ContributeFormState = {
  name: "",
  operator: "",
  state: "",
  facilityType: "data_center",
  status: "proposed",
  lat: "",
  lon: "",
  city: "",
  capacityOperationalMw: "",
  capacityPlannedMw: "",
  sourceUrl: "",
  sourceLabel: "",
  note: "",
  website: "",
};

/** US state codes, sorted by full name, for the <Select>. */
const STATE_OPTIONS = Object.entries(US_STATE_NAMES)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

// ---------------------------------------------------------------------------
// Payload building — mirrors buildFacilityPayload in the admin form: numeric
// string fields parse to `number | undefined` (empty -> undefined, never
// NaN or 0), optional text empties are omitted rather than sent as "".
// ---------------------------------------------------------------------------

export function buildContributePayload(state: ContributeFormState): Record<string, unknown> {
  const num = (v: string): number | undefined => (v.trim() === "" ? undefined : Number(v));

  const payload: Record<string, unknown> = {
    kind: "create",
    website: state.website,
    name: state.name.trim(),
    operator: state.operator.trim(),
    state: state.state.toUpperCase(),
    facilityType: state.facilityType,
    status: state.status,
    lat: num(state.lat),
    lon: num(state.lon),
    sourceUrl: state.sourceUrl.trim(),
  };

  if (state.city.trim()) payload.city = state.city.trim();
  const capacityOperationalMw = num(state.capacityOperationalMw);
  if (capacityOperationalMw !== undefined) payload.capacityOperationalMw = capacityOperationalMw;
  const capacityPlannedMw = num(state.capacityPlannedMw);
  if (capacityPlannedMw !== undefined) payload.capacityPlannedMw = capacityPlannedMw;
  if (state.sourceLabel.trim()) payload.sourceLabel = state.sourceLabel.trim();
  if (state.note.trim()) payload.note = state.note.trim();

  return payload;
}

// ---------------------------------------------------------------------------
// Field-level error surfacing (from a Zod `issues` array on a 400 response)
// ---------------------------------------------------------------------------

type FieldIssues = Record<string, string>;

interface ZodIssue {
  path: (string | number)[];
  message: string;
}

function issuesToFieldMap(issues: unknown): FieldIssues {
  const map: FieldIssues = {};
  if (!Array.isArray(issues)) return map;
  for (const issue of issues) {
    if (
      issue &&
      typeof issue === "object" &&
      "path" in issue &&
      "message" in issue &&
      Array.isArray((issue as { path: unknown }).path)
    ) {
      const path = String((issue as ZodIssue).path[0] ?? "");
      if (path) map[path] = String((issue as ZodIssue).message);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Reusable small field wrappers (mirrors app/admin/facilities/facility-form.tsx)
// ---------------------------------------------------------------------------

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  error,
  required,
  type = "text",
  step,
  min,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  required?: boolean;
  type?: string;
  step?: string;
  min?: string;
  hint?: string;
}) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true" className="text-destructive"> *</span> : null}
      </Label>
      <Input
        id={id}
        name={id}
        type={type}
        step={step}
        min={min}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      />
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <FieldError id={errorId} message={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section: facility (name, operator, type, status)
// ---------------------------------------------------------------------------

function FacilitySection({
  state,
  setState,
  errors,
}: {
  state: ContributeFormState;
  setState: Dispatch<SetStateAction<ContributeFormState>>;
  errors: FieldIssues;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Facility</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <TextField
          id="name"
          label="Name"
          value={state.name}
          onChange={(v) => setState((prev) => ({ ...prev, name: v }))}
          error={errors["name"]}
          required
        />
        <TextField
          id="operator"
          label="Operator"
          value={state.operator}
          onChange={(v) => setState((prev) => ({ ...prev, operator: v }))}
          error={errors["operator"]}
          required
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="facilityType">Type</Label>
            <Select
              value={state.facilityType}
              onValueChange={(v) => {
                if (v === null) return;
                setState((prev) => ({ ...prev, facilityType: v as FacilityType }));
              }}
            >
              <SelectTrigger id="facilityType" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FACILITY_TYPE_ORDER.map((t) => (
                  <SelectItem key={t} value={t}>
                    {FACILITY_TYPE_META[t].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="status">Status</Label>
            <Select
              value={state.status}
              onValueChange={(v) => {
                if (v === null) return;
                setState((prev) => ({ ...prev, status: v as Status }));
              }}
            >
              <SelectTrigger id="status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_ORDER.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_META[s].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section: location (state select, lat/lon, city)
// ---------------------------------------------------------------------------

function LocationSection({
  state,
  setState,
  errors,
}: {
  state: ContributeFormState;
  setState: Dispatch<SetStateAction<ContributeFormState>>;
  errors: FieldIssues;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Location</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="state">
              State
              <span aria-hidden="true" className="text-destructive"> *</span>
            </Label>
            <Select
              value={state.state}
              onValueChange={(v) => {
                if (v === null) return;
                setState((prev) => ({ ...prev, state: v }));
              }}
            >
              <SelectTrigger
                id="state"
                className="w-full"
                aria-invalid={errors["state"] ? true : undefined}
                aria-describedby={errors["state"] ? "state-error" : undefined}
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
            <FieldError id="state-error" message={errors["state"]} />
          </div>
          <TextField
            id="city"
            label="City"
            value={state.city}
            onChange={(v) => setState((prev) => ({ ...prev, city: v }))}
            error={errors["city"]}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            id="lat"
            label="Latitude"
            type="number"
            step="any"
            value={state.lat}
            onChange={(v) => setState((prev) => ({ ...prev, lat: v }))}
            error={errors["lat"]}
            required
          />
          <TextField
            id="lon"
            label="Longitude"
            type="number"
            step="any"
            value={state.lon}
            onChange={(v) => setState((prev) => ({ ...prev, lon: v }))}
            error={errors["lon"]}
            required
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Right-click a spot in Google Maps &mdash; the coordinates copy to
          your clipboard as &ldquo;lat, lon&rdquo;.
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section: capacity (optional)
// ---------------------------------------------------------------------------

function CapacitySection({
  state,
  setState,
  errors,
}: {
  state: ContributeFormState;
  setState: Dispatch<SetStateAction<ContributeFormState>>;
  errors: FieldIssues;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Capacity (optional)</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          id="capacityOperationalMw"
          label="Operational (MW)"
          type="number"
          step="any"
          min="0"
          value={state.capacityOperationalMw}
          onChange={(v) => setState((prev) => ({ ...prev, capacityOperationalMw: v }))}
          error={errors["capacityOperationalMw"]}
        />
        <TextField
          id="capacityPlannedMw"
          label="Planned (MW)"
          type="number"
          step="any"
          min="0"
          value={state.capacityPlannedMw}
          onChange={(v) => setState((prev) => ({ ...prev, capacityPlannedMw: v }))}
          error={errors["capacityPlannedMw"]}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section: source
// ---------------------------------------------------------------------------

function SourceSection({
  state,
  setState,
  errors,
}: {
  state: ContributeFormState;
  setState: Dispatch<SetStateAction<ContributeFormState>>;
  errors: FieldIssues;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Source</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <TextField
          id="sourceUrl"
          label="Source URL"
          type="url"
          value={state.sourceUrl}
          onChange={(v) => setState((prev) => ({ ...prev, sourceUrl: v }))}
          error={errors["sourceUrl"]}
          required
          hint="A public link anyone can check — press release, permit filing, news article."
        />
        <TextField
          id="sourceLabel"
          label="Source label (optional)"
          value={state.sourceLabel}
          onChange={(v) => setState((prev) => ({ ...prev, sourceLabel: v }))}
          error={errors["sourceLabel"]}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section: notes (optional)
// ---------------------------------------------------------------------------

function NotesSection({
  state,
  setState,
  errors,
}: {
  state: ContributeFormState;
  setState: Dispatch<SetStateAction<ContributeFormState>>;
  errors: FieldIssues;
}) {
  const errorId = "note-error";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notes</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        <Label htmlFor="note">Anything else we should know? (optional)</Label>
        <textarea
          id="note"
          name="note"
          value={state.note}
          onChange={(e) => setState((prev) => ({ ...prev, note: e.target.value }))}
          rows={4}
          maxLength={2000}
          className="rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20"
          aria-invalid={errors["note"] ? true : undefined}
          aria-describedby={errors["note"] ? errorId : undefined}
        />
        <FieldError id={errorId} message={errors["note"]} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Honeypot (hidden from humans, off-screen not display:none)
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
      <label htmlFor="website">Website</label>
      <input
        id="website"
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

type SubmitOutcome = "idle" | "success";

export function ContributeFacilityForm() {
  const [state, setState] = useState<ContributeFormState>(EMPTY_STATE);
  const [errors, setErrors] = useState<FieldIssues>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitOutcome>("idle");
  const formErrorId = useId();
  const successRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (outcome === "success") successRef.current?.focus();
  }, [outcome]);

  function handleReset() {
    setState(EMPTY_STATE);
    setErrors({});
    setFormError(undefined);
    setOutcome("idle");
  }

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
        body: JSON.stringify(buildContributePayload(state)),
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

      if (res.status === 400 && json && typeof json === "object") {
        const body = json as { error?: string; issues?: unknown };
        setErrors(issuesToFieldMap(body.issues));
        setFormError(body.error ?? "Please fix the errors below.");
        return;
      }

      if (res.status === 429 && json && typeof json === "object") {
        setFormError((json as { error?: string }).error ?? "Too many submissions. Please try again later.");
        return;
      }

      setFormError("Something went wrong. Please try again.");
    } catch {
      setFormError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (outcome === "success") {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-4 py-2">
          <p
            ref={successRef}
            role="alert"
            tabIndex={-1}
            className="text-base text-foreground outline-none"
          >
            Thank you &mdash; your submission is in the review queue.
          </p>
          <p className="text-sm text-muted-foreground">
            Submissions are anonymous, so there&rsquo;s no way to track this
            one&rsquo;s status. If it checks out, it&rsquo;ll appear on the
            map after review.
          </p>
          <Button type="button" variant="outline" onClick={handleReset}>
            Submit another
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6" noValidate>
      <HoneypotField
        value={state.website}
        onChange={(v) => setState((prev) => ({ ...prev, website: v }))}
      />

      <FacilitySection state={state} setState={setState} errors={errors} />
      <LocationSection state={state} setState={setState} errors={errors} />
      <CapacitySection state={state} setState={setState} errors={errors} />
      <SourceSection state={state} setState={setState} errors={errors} />
      <NotesSection state={state} setState={setState} errors={errors} />

      {formError ? (
        <p id={formErrorId} role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button
          type="submit"
          size="lg"
          disabled={submitting}
          className="min-h-11 min-w-11"
        >
          {submitting ? "Submitting…" : "Submit facility"}
        </Button>
      </div>
    </form>
  );
}
