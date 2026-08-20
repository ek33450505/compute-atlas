"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  HoneypotField,
  TextField,
  issuesToFieldMap,
} from "@/components/contribute/contribute-facility-form";

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface LeadFormState {
  url: string;
  note: string;
  attribution: string;
  /** Honeypot — real submitters never see or fill this. */
  website: string;
}

const EMPTY_STATE: LeadFormState = {
  url: "",
  note: "",
  attribution: "",
  website: "",
};

// ---------------------------------------------------------------------------
// Payload building — optional text empties are omitted rather than sent as
// "" (mirrors buildContributePayload in contribute-facility-form.tsx).
// ---------------------------------------------------------------------------

export function buildLeadPayload(state: LeadFormState): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    url: state.url.trim(),
    website: state.website,
  };

  if (state.note.trim()) payload.note = state.note.trim();
  if (state.attribution.trim()) payload.attribution = state.attribution.trim();

  return payload;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type SubmitOutcome = "idle" | "success";

/**
 * Low-friction lead intake — the default path on /contribute. Two visible
 * fields (a source URL and an optional one-line description) plus optional
 * attribution. POSTs to /api/leads, which fetches and triages the URL
 * server-side after responding (see app/api/leads/route.ts) rather than
 * asking the submitter for facility details up front.
 *
 * Deliberately mirrors ContributeFacilityForm's submit/error/success
 * handling exactly (issuesToFieldMap for per-field Zod errors, a
 * role="alert" form-level error, the focus-managed success panel, and a
 * "Submit another" reset) — reusing its exported TextField/FieldError/
 * HoneypotField building blocks rather than duplicating them.
 */
export function ContributeLeadForm() {
  const [state, setState] = useState<LeadFormState>(EMPTY_STATE);
  const [errors, setErrors] = useState<Record<string, string>>({});
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
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildLeadPayload(state)),
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
            Thanks &mdash; the link is in the queue.
          </p>
          <p className="text-sm text-muted-foreground">
            We check it against the source before anything is published.
            Submissions are anonymous, so there&rsquo;s no status to track
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
        id="leadWebsite"
        value={state.website}
        onChange={(v) => setState((prev) => ({ ...prev, website: v }))}
      />

      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <TextField
            id="leadUrl"
            label="Link to a source"
            type="url"
            value={state.url}
            onChange={(v) => setState((prev) => ({ ...prev, url: v }))}
            error={errors["url"]}
            required
            hint="A news article, permit filing, press release, or county agenda — anything public that anyone can check."
          />
          <TextField
            id="leadNote"
            label="What is it? (optional)"
            value={state.note}
            onChange={(v) => setState((prev) => ({ ...prev, note: v }))}
            error={errors["note"]}
            maxLength={500}
            placeholder="New Meta data center proposed in Bowie County, TX"
            hint="A one-line description helps, but a bare link is genuinely fine."
          />
          <TextField
            id="leadAttribution"
            label="Your name or handle (optional)"
            value={state.attribution}
            onChange={(v) => setState((prev) => ({ ...prev, attribution: v }))}
            error={errors["attribution"]}
            maxLength={40}
            hint="Credited on the public activity feed. Leave blank to stay anonymous — no email addresses."
          />
        </CardContent>
      </Card>

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
          {submitting ? "Submitting…" : "Submit link"}
        </Button>
      </div>
    </form>
  );
}
