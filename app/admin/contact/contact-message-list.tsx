import { AlertTriangle, CheckCircle2 } from "lucide-react";

import type { AdminContactRow } from "@/lib/contact";
import { Badge } from "@/components/ui/badge";

/**
 * Renders whether the notification email actually sent for this message.
 * The failed state is the one meant to draw the eye (bold destructive badge
 * + icon) since a stored-but-undelivered message is exactly the gap this
 * screen exists to surface — the succeeded state is deliberately quiet.
 * Colour is never the only signal: both states pair an icon with text.
 */
function EmailDeliveryStatus({ sent }: { sent: boolean }) {
  if (sent) {
    return (
      <span className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2 className="size-3.5" aria-hidden="true" />
        Notification email sent
      </span>
    );
  }

  return (
    <Badge variant="destructive" className="h-auto w-fit gap-1.5 px-2 py-1 text-xs">
      <AlertTriangle className="size-3.5" aria-hidden="true" />
      Notification email not sent
    </Badge>
  );
}

function ContactMessageRow({ message }: { message: AdminContactRow }) {
  return (
    <div className="rounded-lg border border-border">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{message.topic}</Badge>
            <span className="text-sm font-medium text-foreground">{message.name}</span>
            <a
              href={`mailto:${message.email}`}
              className="text-sm text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {message.email}
            </a>
          </div>
          <p className="shrink-0 text-xs text-muted-foreground">
            {new Date(message.createdAt).toLocaleString()}
          </p>
        </div>
        <p className="text-sm whitespace-pre-wrap text-foreground">{message.message}</p>
        <EmailDeliveryStatus sent={message.emailSent} />
      </div>
    </div>
  );
}

export function ContactMessageList({ messages }: { messages: AdminContactRow[] }) {
  if (messages.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">No contact messages yet.</p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {messages.map((message) => (
        <ContactMessageRow key={message.id} message={message} />
      ))}
    </div>
  );
}
