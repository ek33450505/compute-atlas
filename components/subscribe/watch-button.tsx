"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type WatchTargetType = "facility";

export interface WatchButtonProps {
  targetType: WatchTargetType;
  /** Facility id. */
  targetId: string;
  /** Trigger button copy, e.g. "Watch this facility". */
  label: string;
  className?: string;
}

interface SubscribePayload {
  email: string;
  targetType: WatchTargetType;
  targetId?: string;
  website: string;
}

/**
 * Pure payload builder — mirrors buildContributePayload / buildCorrectionPayload
 * (components/contribute), unit-testable without rendering.
 */
export function buildSubscribePayload(
  email: string,
  targetType: WatchTargetType,
  targetId: string | undefined,
  website: string
): SubscribePayload {
  return { email: email.trim(), targetType, targetId, website };
}

// ---------------------------------------------------------------------------
// Honeypot (hidden from humans, off-screen not display:none) — same pattern
// as contribute-facility-form.tsx / suggest-correction.tsx.
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

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Outcome = "idle" | "success";

/**
 * "Watch this facility / this state / all updates" — progressive-disclosure
 * subscribe control. Collapsed: a single trigger button. Expanded: an inline
 * email form that POSTs to /api/subscribe. The API never reveals whether the
 * address was already subscribed, so every 201 shows the same "check your
 * email" copy (see lib/subscribe.ts).
 */
export function WatchButton({ targetType, targetId, label, className }: WatchButtonProps) {
  const [revealed, setRevealed] = useState(false);
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>("idle");
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const emailId = useId();
  const honeypotId = useId();
  const errorId = useId();
  const emailInputRef = useRef<HTMLInputElement>(null);

  // Move focus into the form when it reveals: the trigger button that held
  // focus unmounts, so without this a keyboard/screen-reader user is stranded
  // on <body>. (frontend-qa, s65.)
  useEffect(() => {
    if (revealed) {
      emailInputRef.current?.focus();
    }
  }, [revealed]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setFormError(undefined);
    setSubmitting(true);

    try {
      const res = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSubscribePayload(email, targetType, targetId, website)),
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

      if ((res.status === 400 || res.status === 429) && json && typeof json === "object") {
        setFormError((json as { error?: string }).error ?? "Something went wrong. Please try again.");
        return;
      }

      setFormError("Something went wrong. Please try again.");
    } catch {
      setFormError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!revealed) {
    return (
      <Button
        type="button"
        variant="outline"
        className={cn("min-h-11", className)}
        onClick={() => setRevealed(true)}
      >
        {label}
      </Button>
    );
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {outcome !== "success" && (
        <form
          onSubmit={handleSubmit}
          className="flex flex-col gap-2 animate-in fade-in-0 slide-in-from-top-1 duration-150 motion-reduce:animate-none"
          noValidate
        >
          <HoneypotField id={honeypotId} value={website} onChange={setWebsite} />
          <p className="text-sm text-muted-foreground">
            Get an email when this changes. One click to unsubscribe, anytime.
          </p>
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-end">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor={emailId}>Email</Label>
              <Input
                ref={emailInputRef}
                id={emailId}
                name="email"
                type="email"
                autoComplete="email"
                required
                disabled={submitting}
                aria-describedby={formError ? errorId : undefined}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={submitting} className="min-h-11">
              {submitting ? "Watching…" : "Watch"}
            </Button>
          </div>
        </form>
      )}

      <div aria-live="polite">
        {outcome === "success" && (
          <p className="text-sm text-foreground">
            Check your email to confirm your subscription.
          </p>
        )}
        {formError && (
          <p id={errorId} className="text-sm text-destructive">
            {formError}
          </p>
        )}
      </div>
    </div>
  );
}
