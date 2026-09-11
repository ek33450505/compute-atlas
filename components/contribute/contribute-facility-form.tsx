"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type Dispatch,
  type SetStateAction,
} from "react";
import Link from "next/link";

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
import { issuesToFieldMap, FieldError, type FieldIssues } from "@/components/contribute/field-primitives";
import { FACILITY_TYPE_ORDER, FACILITY_TYPE_META, type FacilityType } from "@/lib/facility-type";
import { geocodeUS, parseCoordinateString, type GeocodeResult } from "@/lib/geocode";
import { numOrUndefined } from "@/lib/form-payload";
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
  attribution: string;
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
  attribution: "",
  note: "",
  website: "",
};

/** US state codes, sorted by full name, for the <Select>. */
const STATE_OPTIONS = Object.entries(US_STATE_NAMES)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name));

// `items` for each <Select> — Base UI resolves the trigger's displayed label
// from this, not from the rendered <SelectItem> children, so each one is
// derived from the same source the <SelectItem>s below map over (never a
// hand-written second list that can drift from it).
const FACILITY_TYPE_ITEMS = FACILITY_TYPE_ORDER.map((t) => ({
  value: t,
  label: FACILITY_TYPE_META[t].label,
}));
const STATUS_ITEMS = STATUS_ORDER.map((s) => ({
  value: s,
  label: STATUS_META[s].label,
}));
const STATE_ITEMS = STATE_OPTIONS.map((s) => ({ value: s.code, label: s.name }));

// ---------------------------------------------------------------------------
// Payload building — numeric parsing delegated to lib/form-payload.ts
// (shared with the admin form); optional text empties are omitted rather
// than sent as "".
// ---------------------------------------------------------------------------

export function buildContributePayload(state: ContributeFormState): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: "create",
    website: state.website,
    name: state.name.trim(),
    operator: state.operator.trim(),
    state: state.state.toUpperCase(),
    facilityType: state.facilityType,
    status: state.status,
    lat: numOrUndefined(state.lat),
    lon: numOrUndefined(state.lon),
    sourceUrl: state.sourceUrl.trim(),
  };

  if (state.city.trim()) payload.city = state.city.trim();
  const capacityOperationalMw = numOrUndefined(state.capacityOperationalMw);
  if (capacityOperationalMw !== undefined) payload.capacityOperationalMw = capacityOperationalMw;
  const capacityPlannedMw = numOrUndefined(state.capacityPlannedMw);
  if (capacityPlannedMw !== undefined) payload.capacityPlannedMw = capacityPlannedMw;
  if (state.sourceLabel.trim()) payload.sourceLabel = state.sourceLabel.trim();
  if (state.attribution.trim()) payload.attribution = state.attribution.trim();
  if (state.note.trim()) payload.note = state.note.trim();

  return payload;
}

// ---------------------------------------------------------------------------
// Field-level error primitives (issuesToFieldMap, FieldError) now live in
// ./field-primitives.tsx, shared with suggest-correction.tsx. Re-exported
// here so existing consumers (contact-form.tsx, access-request-form.tsx,
// contribute-lead-form.tsx) don't need to change their import path.
// ---------------------------------------------------------------------------

export { issuesToFieldMap, FieldError, type FieldIssues };

// ---------------------------------------------------------------------------
// Reusable small field wrappers (mirrors app/admin/facilities/facility-form.tsx)
// ---------------------------------------------------------------------------

export function TextField({
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
  maxLength,
  placeholder,
  inputMode,
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
  maxLength?: number;
  placeholder?: string;
  inputMode?: ComponentProps<"input">["inputMode"];
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
        maxLength={maxLength}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        inputMode={inputMode}
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
              items={FACILITY_TYPE_ITEMS}
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
              items={STATUS_ITEMS}
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
// Coordinate-entry helpers (additive — the two manual lat/lon inputs below
// keep working exactly as before as a fallback). B5/B6a: paste-and-split is
// the cheap, high-value win — most people already have "lat, lon" on their
// clipboard from Google Maps and shouldn't have to split it by hand. B6b:
// an optional address search reusing the same Nominatim client the map uses
// (lib/geocode.ts, geocodeUS) — it must never block submission if the
// geocoder is unreachable, so failures just fall back to silence + manual
// entry, never a dead end.
// ---------------------------------------------------------------------------

type CoordinateHelperStatus = "idle" | "filled" | "invalid";

function CoordinatePasteField({
  onParsed,
}: {
  onParsed: (lat: number, lon: number) => void;
}) {
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<CoordinateHelperStatus>("idle");
  const hintId = useId();

  function handleChange(next: string) {
    setValue(next);
    if (next.trim() === "") {
      setStatus("idle");
      return;
    }
    const parsed = parseCoordinateString(next);
    if (parsed) {
      onParsed(parsed.lat, parsed.lon);
      setStatus("filled");
    }
    // Leave status as-is while still typing an incomplete value — only
    // flag "invalid" on blur, below, so a screen reader isn't told the
    // field is wrong on every keystroke before the user has finished.
  }

  function handleBlur() {
    if (value.trim() === "") {
      setStatus("idle");
      return;
    }
    setStatus(parseCoordinateString(value) ? "filled" : "invalid");
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="coordPaste">Paste coordinates</Label>
      <Input
        id="coordPaste"
        name="coordPaste"
        type="text"
        autoComplete="off"
        placeholder="39.51, -98.53"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        aria-describedby={hintId}
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        Right-click a spot in Google Maps &mdash; the coordinates copy to
        your clipboard as &ldquo;lat, lon&rdquo;. Paste them here to fill
        both fields below.
      </p>
      <div role="status" aria-live="polite" aria-atomic="true" className="text-xs">
        {status === "filled" ? (
          <span className="text-foreground">
            Latitude and longitude filled from pasted coordinates.
          </span>
        ) : status === "invalid" ? (
          <span className="text-muted-foreground">
            Couldn&rsquo;t read that as coordinates &mdash; try
            &ldquo;39.51, -98.53&rdquo;, or enter the fields below by hand.
          </span>
        ) : null}
      </div>
    </div>
  );
}

type AddressSearchStatus = "idle" | "loading" | "empty" | "error";

function AddressSearchField({
  onSelect,
}: {
  onSelect: (lat: number, lon: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<AddressSearchStatus>("idle");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintId = useId();

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function runSearch(q: string) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("loading");
    setResults([]);

    geocodeUS(q, controller.signal)
      .then((found) => {
        abortRef.current = null;
        if (found.length === 0) {
          setStatus("empty");
        } else if (found.length === 1) {
          onSelect(found[0].lat, found[0].lon);
          setStatus("idle");
        } else {
          setResults(found);
          setStatus("idle");
        }
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name === "AbortError") return;
        abortRef.current = null;
        // Never surfaces as a form-blocking error — manual lat/lon entry
        // (and the paste field above) keep working unaffected.
        setStatus("error");
      });
  }

  function handleChange(next: string) {
    setQuery(next);
    setResults([]);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = next.trim();
    if (trimmed.length < 3) {
      abortRef.current?.abort();
      setStatus("idle");
      return;
    }

    // 700ms debounce keeps us comfortably under Nominatim's ~1 req/sec
    // usage-policy ceiling even across a couple of short typing pauses;
    // any still-in-flight request is aborted the moment a newer one fires.
    debounceRef.current = setTimeout(() => runSearch(trimmed), 700);
  }

  function handleResultSelect(result: GeocodeResult) {
    onSelect(result.lat, result.lon);
    setResults([]);
    setQuery("");
    setStatus("idle");
  }

  const statusMessage =
    status === "loading"
      ? "Searching…"
      : status === "empty"
        ? "No matching address found — try coordinates instead."
        : status === "error"
          ? "Address search is unavailable right now — enter coordinates below."
          : "";

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="addressSearch">Or search an address (optional)</Label>
      <Input
        id="addressSearch"
        name="addressSearch"
        type="text"
        autoComplete="off"
        placeholder="123 Main St, Springfield, IL"
        value={query}
        onChange={(e) => handleChange(e.target.value)}
        aria-describedby={hintId}
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        Looks up a street address via OpenStreetMap and fills the
        coordinates below. If it&rsquo;s unavailable, paste or type
        coordinates directly instead.
      </p>
      {results.length > 0 ? (
        <ul aria-label="Address search results" className="flex flex-col gap-1 rounded-lg border border-input p-1">
          {results.map((result) => (
            <li key={`${result.lat},${result.lon}`}>
              <button
                type="button"
                onClick={() => handleResultSelect(result)}
                className="w-full rounded px-2 py-1 text-left text-sm text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {result.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div role="status" aria-live="polite" aria-atomic="true" className="text-xs text-muted-foreground">
        {statusMessage}
      </div>
    </div>
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
  function handleCoordinatesFound(lat: number, lon: number) {
    setState((prev) => ({ ...prev, lat: String(lat), lon: String(lon) }));
  }

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
              items={STATE_ITEMS}
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

        <AddressSearchField onSelect={handleCoordinatesFound} />
        <CoordinatePasteField onParsed={handleCoordinatesFound} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            id="lat"
            label="Latitude"
            type="number"
            step="any"
            inputMode="decimal"
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
            inputMode="decimal"
            value={state.lon}
            onChange={(v) => setState((prev) => ({ ...prev, lon: v }))}
            error={errors["lon"]}
            required
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Or enter latitude and longitude directly &mdash; decimal degrees,
          e.g. 39.51 and -98.53.
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
        <TextField
          id="attribution"
          label="Your name or handle (optional)"
          value={state.attribution}
          onChange={(v) => setState((prev) => ({ ...prev, attribution: v }))}
          error={errors["attribution"]}
          maxLength={40}
          hint="Credited on the public activity feed. Leave blank to stay anonymous — no email addresses."
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

export function HoneypotField({
  id = "website",
  value,
  onChange,
}: {
  /** DOM id/name — override when co-mounting more than one form on a page
   * (e.g. /contribute renders this alongside ContributeFacilityForm's own
   * honeypot) so ids stay document-unique. Field key in the JSON payload is
   * always `website`, independent of this. */
  id?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
      <label htmlFor={id}>Website</label>
      <input
        id={id}
        name={id}
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
            Most submissions are reviewed within about a week. If it checks
            out, it will appear on the map and on the{" "}
            <Link
              href="/activity"
              className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              public activity feed
            </Link>
            . Submissions are anonymous, so there&rsquo;s no status to track
            this one.
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
