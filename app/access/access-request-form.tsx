"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { HoneypotField, issuesToFieldMap } from "@/components/contribute/contribute-facility-form";

// Local copy of DATASET_CATEGORIES from lib/db/schema: that module imports the
// DB client, which must not reach a client bundle. A drift test keeps them equal.
export const DATASET_CATEGORY_OPTIONS = [
  { value: "journalist", label: "Journalist" },
  { value: "academic", label: "Academic or researcher" },
  { value: "nonprofit", label: "Nonprofit" },
  { value: "government", label: "Government" },
  { value: "commercial", label: "Commercial" },
  { value: "other", label: "Other" },
] as const;

const INTENDED_USE_MAX = 2000;
const LINK_COUNT = 3;
const NAME_MAX = 200;
const EMAIL_MAX = 254;

const MSG_SUCCESS =
  "Check your inbox: if this address can receive mail from us, a message about this request is on its way.";
const MSG_TOO_LONG = "That is too long to send.";
const MSG_RATE = "Too many requests from this network. Try again in an hour.";
const MSG_UNAVAILABLE = "Requests are temporarily unavailable. Try again later.";

interface FormState {
  email: string;
  name: string;
  organization: string;
  role: string;
  category: string;
  intendedUse: string;
  links: string[];
  attributionAck: boolean;
  termsAccepted: boolean;
  /** Honeypot: real submitters never see or fill this. */
  website: string;
}

const EMPTY_STATE: FormState = {
  email: "",
  name: "",
  organization: "",
  role: "",
  category: "",
  intendedUse: "",
  links: Array.from({ length: LINK_COUNT }, () => ""),
  attributionAck: false,
  termsAccepted: false,
  website: "",
};

/** Error-summary order, label, and the id of the control each error links to. */
const FIELD_ORDER: { key: string; id: string }[] = [
  { key: "email", id: "access-email" },
  { key: "name", id: "access-name" },
  { key: "organization", id: "access-organization" },
  { key: "role", id: "access-role" },
  { key: "category", id: "access-category" },
  { key: "intendedUse", id: "access-intendedUse" },
  { key: "links", id: "access-link-0" },
  { key: "attributionAck", id: "access-attributionAck" },
  { key: "termsAccepted", id: "access-termsAccepted" },
];

export function buildAccessPayload(state: FormState): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    email: state.email.trim(),
    name: state.name.trim(),
    category: state.category,
    intendedUse: state.intendedUse.trim(),
    links: state.links.map((l) => l.trim()).filter(Boolean),
    website: state.website,
  };
  if (state.organization.trim()) payload.organization = state.organization.trim();
  if (state.role.trim()) payload.role = state.role.trim();
  if (state.attributionAck) payload.attributionAck = true;
  if (state.termsAccepted) payload.termsAccepted = true;
  return payload;
}

function validate(state: FormState): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!state.email.trim()) errors.email = "Enter your email address.";
  if (!state.name.trim()) errors.name = "Enter your name.";
  if (!state.category) errors.category = "Choose a category.";
  if (!state.intendedUse.trim()) errors.intendedUse = "Describe how you plan to use the data.";
  if (!state.attributionAck) errors.attributionAck = "Confirm that you will credit Compute Atlas.";
  if (!state.termsAccepted) errors.termsAccepted = "Accept the access terms to continue.";
  return errors;
}

const CONTROL_CLASS =
  "rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-transparent aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20";

/**
 * Inline field error. Deliberately not the shared FieldError: that carries
 * role="alert", and here the error summary is the only live region.
 */
function InlineError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {message}
    </p>
  );
}

function Req() {
  return (
    <span aria-hidden="true" className="text-destructive">
      {" "}
      *
    </span>
  );
}

function describedBy(...ids: (string | false | undefined)[]): string | undefined {
  return ids.filter(Boolean).join(" ") || undefined;
}

function TextField({
  name,
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
  name: string;
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
  const id = `access-${name}`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <Req /> : null}
      </Label>
      <Input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        maxLength={maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(error && `${id}-error`, hint && `${id}-hint`)}
      />
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <InlineError id={`${id}-error`} message={error} />
    </div>
  );
}

function CheckboxField({
  name,
  checked,
  onChange,
  error,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  error?: string;
  children: React.ReactNode;
}) {
  const id = `access-${name}`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        <input
          id={id}
          name={name}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(error && `${id}-error`)}
          className="mt-1 size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
        <Label htmlFor={id} className="text-sm leading-snug">
          {children}
          <Req />
        </Label>
      </div>
      <InlineError id={`${id}-error`} message={error} />
    </div>
  );
}

/**
 * The /access request form. POSTs to /api/access/request. Every 202 shows the
 * same message, so the page cannot be used to learn whether an address is
 * already known. Terms text arrives from the server page; nothing here may
 * import the DB client.
 */
export function AccessRequestForm({ termsVersion }: { termsVersion: string }) {
  const [state, setState] = useState<FormState>(EMPTY_STATE);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  // Synchronous re-entry guard: state updates lag a double click or double Enter.
  const inFlight = useRef(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const hasSummary = Object.keys(errors).length > 0 || formError !== undefined;

  useEffect(() => {
    if (done) statusRef.current?.focus();
  }, [done]);

  useEffect(() => {
    if (hasSummary) summaryRef.current?.focus();
  }, [hasSummary, errors, formError]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    setFormError(undefined);

    const local = validate(state);
    if (Object.keys(local).length > 0) {
      setErrors(local);
      return;
    }
    setErrors({});
    inFlight.current = true;
    setSubmitting(true);

    try {
      const res = await fetch("/api/access/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildAccessPayload(state)),
      });

      if (res.status === 202) {
        setDone(true);
        return;
      }
      if (res.status === 400) {
        let json: unknown;
        try {
          json = await res.json();
        } catch {
          // no usable body: fall through to a generic summary
        }
        const body = (json && typeof json === "object" ? json : {}) as { issues?: unknown };
        const map = issuesToFieldMap(body.issues);
        if (Object.keys(map).length > 0) {
          setErrors(map);
        } else {
          setFormError("Please check the form and try again.");
        }
        return;
      }
      if (res.status === 413) setFormError(MSG_TOO_LONG);
      else if (res.status === 429) setFormError(MSG_RATE);
      else setFormError(MSG_UNAVAILABLE);
    } catch {
      setFormError(MSG_UNAVAILABLE);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <Card>
        <CardContent className="py-2">
          <p
            ref={statusRef}
            role="status"
            tabIndex={-1}
            className="text-base text-foreground outline-none"
          >
            {MSG_SUCCESS}
          </p>
        </CardContent>
      </Card>
    );
  }

  const summaryItems = FIELD_ORDER.filter((f) => errors[f.key]);
  const useId = "access-intendedUse";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6" noValidate>
      <HoneypotField
        id="accessWebsite"
        value={state.website}
        onChange={(v) => set("website", v)}
      />

      {hasSummary ? (
        <div
          ref={summaryRef}
          role="alert"
          tabIndex={-1}
          aria-labelledby="access-error-heading"
          className="rounded-lg border border-destructive p-4 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <p id="access-error-heading" className="font-medium text-destructive">
            {summaryItems.length > 0
              ? "Please fix the errors below."
              : (formError ?? "Please check the form and try again.")}
          </p>
          {summaryItems.length > 0 ? (
            <ul className="mt-2 list-disc pl-5">
              {summaryItems.map((f) => (
                <li key={f.key}>
                  <a
                    href={`#${f.id}`}
                    className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-sm"
                  >
                    {errors[f.key]}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          {summaryItems.length > 0 && formError ? <p className="mt-2">{formError}</p> : null}
        </div>
      ) : null}

      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <TextField
            name="email"
            label="Email"
            type="email"
            autoComplete="email"
            value={state.email}
            onChange={(v) => set("email", v)}
            error={errors.email}
            required
            maxLength={EMAIL_MAX}
            hint="Used to confirm the request and send access mail. Never published."
          />
          <TextField
            name="name"
            label="Name"
            autoComplete="name"
            value={state.name}
            onChange={(v) => set("name", v)}
            error={errors.name}
            required
            maxLength={NAME_MAX}
          />
          <TextField
            name="organization"
            label="Organization"
            autoComplete="organization"
            value={state.organization}
            onChange={(v) => set("organization", v)}
            error={errors.organization}
            maxLength={NAME_MAX}
          />
          <TextField
            name="role"
            label="Role"
            autoComplete="organization-title"
            value={state.role}
            onChange={(v) => set("role", v)}
            error={errors.role}
            maxLength={NAME_MAX}
          />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="access-category">
              Category
              <Req />
            </Label>
            <select
              id="access-category"
              name="category"
              value={state.category}
              onChange={(e) => set("category", e.target.value)}
              required
              aria-invalid={errors.category ? true : undefined}
              aria-describedby={describedBy(errors.category && "access-category-error")}
              className={`${CONTROL_CLASS} h-8 w-full`}
            >
              <option value="">Choose a category</option>
              {DATASET_CATEGORY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <InlineError id="access-category-error" message={errors.category} />
          </div>

          <div className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={useId}>
                Intended use
                <Req />
              </Label>
              <span id={`${useId}-count`} className="font-mono text-[11px] text-muted-foreground">
                {state.intendedUse.length} of {INTENDED_USE_MAX}
              </span>
            </div>
            <textarea
              id={useId}
              name="intendedUse"
              value={state.intendedUse}
              onChange={(e) => set("intendedUse", e.target.value)}
              required
              maxLength={INTENDED_USE_MAX}
              rows={6}
              className={CONTROL_CLASS}
              aria-invalid={errors.intendedUse ? true : undefined}
              aria-describedby={describedBy(
                errors.intendedUse && `${useId}-error`,
                `${useId}-hint`,
                `${useId}-count`,
              )}
            />
            <p id={`${useId}-hint`} className="text-xs text-muted-foreground">
              What you are working on and how the data will be used.
            </p>
            <InlineError id={`${useId}-error`} message={errors.intendedUse} />
          </div>

          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium">Links (optional)</legend>
            <p id="access-links-hint" className="text-xs text-muted-foreground">
              A published story, paper or project page.
            </p>
            {state.links.map((link, i) => (
              <div key={i} className="flex flex-col gap-1.5">
                <Label htmlFor={`access-link-${i}`}>Link {i + 1}</Label>
                <Input
                  id={`access-link-${i}`}
                  name={`link${i + 1}`}
                  type="url"
                  value={link}
                  onChange={(e) =>
                    setState((prev) => ({
                      ...prev,
                      links: prev.links.map((l, j) => (j === i ? e.target.value : l)),
                    }))
                  }
                  aria-invalid={errors.links ? true : undefined}
                  aria-describedby={describedBy(
                    i === 0 && errors.links && "access-links-error",
                    "access-links-hint",
                  )}
                />
              </div>
            ))}
            <InlineError id="access-links-error" message={errors.links} />
          </fieldset>

          <CheckboxField
            name="attributionAck"
            checked={state.attributionAck}
            onChange={(v) => set("attributionAck", v)}
            error={errors.attributionAck}
          >
            I will credit Compute Atlas when publishing work that uses the data (CC BY 4.0)
          </CheckboxField>
          <CheckboxField
            name="termsAccepted"
            checked={state.termsAccepted}
            onChange={(v) => set("termsAccepted", v)}
            error={errors.termsAccepted}
          >
            I accept the access terms (version {termsVersion})
          </CheckboxField>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button
          type="submit"
          size="lg"
          aria-disabled={submitting}
          className="min-h-11 min-w-11"
        >
          {submitting ? "Sending…" : "Request access"}
        </Button>
      </div>
    </form>
  );
}
