"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  FieldError,
  HoneypotField,
  issuesToFieldMap,
} from "@/components/contribute/contribute-facility-form";

interface AccessFormState {
  email: string;
  /** Honeypot — real submitters never see or fill this. */
  website: string;
}

const EMPTY_STATE: AccessFormState = { email: "", website: "" };

type SubmitOutcome = "idle" | "success";

/**
 * The /access form — requests a double-opt-in bulk API access grant.
 * Deliberately mirrors ContactForm's (components/contact/contact-form.tsx)
 * submit/error/success handling: issuesToFieldMap for per-field Zod errors, a
 * role="alert" form-level error, a focus-managed success panel. POSTs to
 * /api/access/request, which always returns a generic `{ok:true}` on success
 * (including duplicate-email and honeypot paths) — this form never learns
 * which case applied, by design (enumeration safety).
 */
export function AccessRequestForm() {
  const [state, setState] = useState<AccessFormState>(EMPTY_STATE);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<SubmitOutcome>("idle");
  const formErrorId = useId();
  const successRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (outcome === "success") successRef.current?.focus();
  }, [outcome]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFormError(undefined);
    setErrors({});
    setSubmitting(true);

    try {
      const res = await fetch("/api/access/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: state.email.trim(), website: state.website }),
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
        setFormError((json as { error?: string }).error ?? "Too many requests. Please try again later.");
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
            Check your inbox &mdash; we sent a confirmation link.
          </p>
          <p className="text-sm text-muted-foreground">
            Click the link in the email to get your access token. It&rsquo;s shown once, so
            keep it somewhere safe.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6" noValidate>
      <HoneypotField
        id="accessWebsite"
        value={state.website}
        onChange={(v) => setState((prev) => ({ ...prev, website: v }))}
      />

      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="accessEmail">
              Email
              <span aria-hidden="true" className="text-destructive"> *</span>
            </Label>
            <Input
              id="accessEmail"
              name="email"
              type="email"
              autoComplete="email"
              maxLength={254}
              value={state.email}
              onChange={(e) => setState((prev) => ({ ...prev, email: e.target.value }))}
              required
              aria-invalid={errors["email"] ? true : undefined}
              aria-describedby={errors["email"] ? "accessEmail-error" : undefined}
            />
            <FieldError id="accessEmail-error" message={errors["email"]} />
          </div>
        </CardContent>
      </Card>

      {formError ? (
        <p id={formErrorId} role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Just want a one-time download instead?{" "}
          <Link
            href="/data"
            className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
          >
            Get the data
          </Link>
          .
        </p>
        <Button type="submit" size="lg" disabled={submitting} className="min-h-11 min-w-11">
          {submitting ? "Sending…" : "Request access"}
        </Button>
      </div>
    </form>
  );
}
