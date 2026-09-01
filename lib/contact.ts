import { z } from "zod";
import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { contactMessagesTable, type ContactMessageRow } from "@/lib/db/schema";

export const CONTACT_TOPICS = ["press", "research", "partnership", "correction", "other"] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];

export const contactInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  topic: z.enum(CONTACT_TOPICS),
  message: z.string().trim().min(20).max(4000),
  website: z.string().max(200).optional(), // honeypot field; checked by the route before createContactMessage
});

export type ContactInput = z.infer<typeof contactInputSchema>;

export type ContactResult =
  | { ok: true; id: string; name: string; email: string; topic: ContactTopic; message: string }
  | { ok: false; status: number; error: string; issues?: unknown };

/**
 * Validates the envelope and inserts a new contact_messages row. Email is
 * normalized (trimmed + lowercased, matching the subscriptions convention in
 * lib/subscribe.ts) and name/message are trimmed before storage. Does not
 * send the email itself — the route composes this with `sendContactEmail`
 * (lib/email.ts) after the row is durably stored, so a Resend failure never
 * loses correspondence.
 */
export async function createContactMessage(input: unknown, ipHash: string): Promise<ContactResult> {
  const parsed = contactInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid contact message", issues: parsed.error.issues };
  }
  const { name, topic, message } = parsed.data;
  const email = parsed.data.email.toLowerCase();

  const db = getDb();
  const [row] = await db
    .insert(contactMessagesTable)
    .values({
      name,
      email,
      topic,
      message,
      submitterIpHash: ipHash,
    })
    .returning({ id: contactMessagesTable.id });

  return { ok: true, id: row.id, name, email, topic, message };
}

/**
 * Records whether the notification email actually sent, once the `after()`
 * send in the route resolves. Mirrors `setLeadTriage` (lib/leads.ts) — a
 * best-effort follow-up write against a row that already exists, so a
 * failure here never affects the stored message itself.
 */
export async function setContactEmailSent(id: string, sent: boolean): Promise<ContactMessageRow | undefined> {
  const db = getDb();
  const rows = await db
    .update(contactMessagesTable)
    .set({ emailSent: sent })
    .where(eq(contactMessagesTable.id, id))
    .returning();
  return rows[0];
}
