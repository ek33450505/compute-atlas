"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { replyToContactMessageAction } from "@/app/admin/contact/actions";

const REPLY_MAX = 10_000;

/**
 * Replies to a contact message as Compute Atlas. Only the message id is sent
 * to the server — the recipient address is looked up server-side, so it never
 * needs to be (and cannot be) supplied from here.
 */
export function ContactReplyForm({
  messageId,
  recipientName,
}: {
  messageId: string;
  recipientName: string;
}) {
  const textareaId = useId();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [sentCount, setSentCount] = useState(0);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [isPending, startTransition] = useTransition();

  // The form collapses on success, which would drop focus to <body>.
  useEffect(() => {
    if (sentCount > 0) toggleRef.current?.focus();
  }, [sentCount]);

  const canSend = !isPending && body.trim().length > 0;

  function handleSend() {
    startTransition(async () => {
      try {
        const result = await replyToContactMessageAction(messageId, body);
        if (result.ok) {
          setBody("");
          setOpen(false);
          setSentCount((n) => n + 1);
          toast.success("Reply sent");
        } else {
          toast.error(result.error || "Failed to send reply.");
        }
      } catch {
        toast.error("Failed to send reply.");
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      {sentCount > 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          Reply sent
        </p>
      ) : null}
      <div>
        <Button
          type="button"
          ref={toggleRef}
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-controls={textareaId}
          onClick={() => setOpen((v) => !v)}
        >
          Reply as Compute Atlas
        </Button>
      </div>
      {open ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={textareaId}>Reply to {recipientName}</Label>
          <textarea
            id={textareaId}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={REPLY_MAX}
            rows={6}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          />
          <p className="text-xs text-muted-foreground">
            Sent from Compute Atlas via Resend — your personal address is never shown.
          </p>
          <div>
            <Button type="button" size="sm" disabled={!canSend} onClick={handleSend}>
              {isPending ? "Sending…" : "Send"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
