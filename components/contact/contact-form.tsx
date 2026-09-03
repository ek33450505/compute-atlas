"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FieldError,
  HoneypotField,
  issuesToFieldMap,
} from "@/components/contribute/contribute-facility-form";

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

/** Matches the topic enum in the POST /api/contact contract. */
export type ContactTopic = "press" | "research" | "partnership" | "correction" | "other";

interface ContactFormState {
  name: string;
  email: string;
  /** Empty string means "not yet chosen" — narrowed to ContactTopic on submit. */
  topic: ContactTopic | "";
  message: string;
  /** Honeypot — real submitters never see or fill this. */
  website: string;
}

const EMPTY_STATE: ContactFormState = {
  name: "",
  email: "",
  topic: "",
  message: "",
  website: "",
};

const TOPIC_OPTIONS: { value: ContactTopic; label: string }[] = [
  { value: "press", label: "Press inquiry" },
  { value: "research", label: "Research or academic inquiry" },
  { value: "partnership", label: "Partnership" },
  { value: "correction", label: "Correction to the project or site" },
  { value: "other", label: "Something else" },
];

const MESSAGE_MIN = 20;
const MESSAGE_MAX = 4000;

// ---------------------------------------------------------------------------
// Payload building — mirrors buildLeadPayload / buildContributePayload.
// ---------------------------------------------------------------------------

export function buildContactPayload(state: ContactFormState): Record<string, unknown> {
  return {
    name: state.name.trim(),
    email: state.email.trim(),
    topic: state.topic,
    message: state.message.trim(),
    website: state.website,
  };
}

// ---------------------------------------------------------------------------
// Text field — TextField (contribute-facility-form) has no `autoComplete`
// prop, which this form needs (name/email), so this is the minimal sibling
// primitive rather than editing the shared form. Mirrors TextField's markup
// exactly otherwise.
// ---------------------------------------------------------------------------

function ContactTextField({
  id,
  label,
  value,
  onChange,
  error,
  required,
  type = "text",
  autoComplete,
  maxLength,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  required?: boolean;
  type?: string;
  autoComplete?: string;
  maxLength?: number;
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
        autoComplete={autoComplete}
        maxLength={maxLength}
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
// Textarea field — TextField (contribute-facility-form) has no textarea
// variant, so this is the minimal sibling primitive for `message`, with an
// always-visible character counter (server enforces MESSAGE_MIN..MESSAGE_MAX
// too; this is just faster feedback).
// ---------------------------------------------------------------------------

function MessageField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const errorId = "message-error";
  const hintId = "message-hint";
  const describedBy = [error ? errorId : null, hintId].filter(Boolean).join(" ");

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor="message">
          Message
          <span aria-hidden="true" className="text-destructive"> *</span>
        </Label>
        <span className="font-mono text-[11px] text-muted-foreground">
          {value.length}/{MESSAGE_MAX}
        </span>
      </div>
      <textarea
        id="message"
        name="message"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        minLength={MESSAGE_MIN}
        maxLength={MESSAGE_MAX}
        rows={6}
        className="rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
      />
      <p id={hintId} className="text-xs text-muted-foreground">
        Between {MESSAGE_MIN} and {MESSAGE_MAX} characters.
      </p>
      <FieldError id={errorId} message={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Topic field — a Select (mirrors FacilitySection's Type/Status selects in
// contribute-facility-form.tsx), with an inline pointer back to /contribute
// for the two intakes this form deliberately excludes.
// ---------------------------------------------------------------------------

function TopicField({
  value,
  onChange,
  error,
}: {
  value: ContactFormState["topic"];
  onChange: (v: ContactTopic) => void;
  error?: string;
}) {
  const errorId = "topic-error";
  const hintId = "topic-hint";

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="topic">
        Topic
        <span aria-hidden="true" className="text-destructive"> *</span>
      </Label>
      <Select
        items={TOPIC_OPTIONS}
        value={value}
        onValueChange={(v) => {
          if (v === null) return;
          onChange(v as ContactTopic);
        }}
      >
        <SelectTrigger
          id="topic"
          className="w-full"
          aria-invalid={error ? true : undefined}
          aria-describedby={[error ? errorId : null, hintId].filter(Boolean).join(" ") || undefined}
        >
          <SelectValue placeholder="Choose a topic" />
        </SelectTrigger>
        <SelectContent>
          {TOPIC_OPTIONS.map((t) => (
            <SelectItem key={t.value} value={t.value}>
              {t.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={hintId} className="text-xs text-muted-foreground">
        Have a lead on a facility, or a correction to a specific record?
        Those go through review on{" "}
        <Link
          href="/contribute"
          className="underline underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
        >
          /contribute
        </Link>{" "}
        instead.
      </p>
      <FieldError id={errorId} message={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type SubmitOutcome = "idle" | "success";

/**
 * The /contact form — press, research, partnership, and site-level
 * corrections. Deliberately mirrors ContributeLeadForm /
 * ContributeFacilityForm's submit/error/success handling exactly
 * (issuesToFieldMap for per-field Zod errors, a role="alert" form-level
 * error, the focus-managed success panel, and a "Send another" reset),
 * reusing their exported TextField/FieldError/HoneypotField building blocks
 * rather than duplicating them. POSTs to /api/contact.
 */
export function ContactForm() {
  const [state, setState] = useState<ContactFormState>(EMPTY_STATE);
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

    // Base UI's <Select> isn't a native <select>, and the form carries
    // noValidate (see NotesSection/MessageField above), so a required Select
    // with nothing chosen never blocks submission on its own — without this
    // check the form POSTed an empty topic to the server and surfaced only a
    // generic "Something went wrong", not an announced field error.
    if (!state.topic) {
      setErrors({ topic: "Choose a topic." });
      setFormError("Please fix the errors below.");
      return;
    }

    setSubmitting(true);

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildContactPayload(state)),
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
        setFormError((json as { error?: string }).error ?? "Too many messages. Please try again later.");
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
            Thanks &mdash; your message is on its way.
          </p>
          <p className="text-sm text-muted-foreground">
            This is one person, so replies aren&rsquo;t instant, but every
            message is read.
          </p>
          <p className="text-sm text-muted-foreground">
            Looking for the raw data instead of getting in touch?{" "}
            <Link
              href="/data"
              className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
            >
              Get the data
            </Link>
            .
          </p>
          <Button type="button" variant="outline" onClick={handleReset}>
            Send another
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6" noValidate>
      <HoneypotField
        id="contactWebsite"
        value={state.website}
        onChange={(v) => setState((prev) => ({ ...prev, website: v }))}
      />

      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <ContactTextField
            id="contactName"
            label="Name"
            autoComplete="name"
            value={state.name}
            onChange={(v) => setState((prev) => ({ ...prev, name: v }))}
            error={errors["name"]}
            required
            maxLength={120}
          />
          <ContactTextField
            id="contactEmail"
            label="Email"
            type="email"
            autoComplete="email"
            value={state.email}
            onChange={(v) => setState((prev) => ({ ...prev, email: v }))}
            error={errors["email"]}
            required
            maxLength={200}
            hint="Used only to reply — never published, never shared."
          />
          <TopicField
            value={state.topic}
            onChange={(v) => setState((prev) => ({ ...prev, topic: v }))}
            error={errors["topic"]}
          />
          <MessageField
            value={state.message}
            onChange={(v) => setState((prev) => ({ ...prev, message: v }))}
            error={errors["message"]}
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
          {submitting ? "Sending…" : "Send message"}
        </Button>
      </div>
    </form>
  );
}
