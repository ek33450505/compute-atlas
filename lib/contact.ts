import { z } from "zod";
import { eq, desc } from "drizzle-orm";

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
 * The columns the admin contact-messages screen renders. Deliberately
 * excludes `submitterIpHash` (a hashed submitter IP — pseudonymous personal
 * data about an anonymous member of the public): every field on a row
 * passed from a server component into a client component crosses into the
 * browser in the RSC payload whether or not it's rendered in JSX, so an
 * unprojected `ContactMessageRow[]` would ship the hash to the admin's
 * browser unused. Selecting an explicit column list (rather than stripping
 * fields after the fact) means a future column added to
 * `contactMessagesTable` can't silently start leaking here too.
 * `submitterIpHash` stays readable server-side via the full
 * `ContactMessageRow` for rate limiting. Mirrors `ADMIN_LEAD_COLUMNS` in
 * lib/leads.ts.
 */
const ADMIN_CONTACT_COLUMNS = {
  id: contactMessagesTable.id,
  createdAt: contactMessagesTable.createdAt,
  name: contactMessagesTable.name,
  email: contactMessagesTable.email,
  topic: contactMessagesTable.topic,
  message: contactMessagesTable.message,
  emailSent: contactMessagesTable.emailSent,
} as const;

export type AdminContactRow = Pick<
  ContactMessageRow,
  "id" | "createdAt" | "name" | "email" | "topic" | "message" | "emailSent"
>;

/** Lists contact messages for the admin screen, newest first. */
export async function listContactMessagesForAdmin(): Promise<AdminContactRow[]> {
  const db = getDb();
  return db
    .select(ADMIN_CONTACT_COLUMNS)
    .from(contactMessagesTable)
    .orderBy(desc(contactMessagesTable.createdAt));
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
