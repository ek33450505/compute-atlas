import { z } from "zod";
import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";

import { isHoneypotTripped } from "@/lib/contribute";
import { getDb } from "@/lib/db/client";
import { redactedErrorCode } from "@/lib/db-error";
import {
  DATASET_CATEGORIES,
  DATASET_OPEN_GRANT_STATUSES,
  datasetAccessGrantsTable,
  type DatasetCategory,
  type DatasetGrantStatus,
} from "@/lib/db/schema";
import { generateToken } from "@/lib/email";
import { normalizeEmail } from "@/lib/email-address";
import { hasUnstorableChars, httpUrlSchema, storableText } from "@/lib/intake-fields";
import { checkDatasetRequestEmailCap } from "@/lib/rate-limit";
import { isSuppressed, mayEmail } from "@/lib/suppressions";
import { hashToken } from "@/lib/token-hash";

/** The access terms text lands in lib/dataset-terms.ts later; this is the single source of the version string a grant records. */
export const DATASET_TERMS_VERSION = "2026-11-draft";

/** Shape of every raw dataset token (`generateToken`: 256 bits, base64url, 43 chars). Checked before any DB call. */
export const DATASET_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const datasetRequestInputSchema = z.object({
  email: z.string().email().max(254),
  // Free text goes through `storableText`: a NUL or an unpaired surrogate would pass Zod and then
  // fail at the jsonb/text insert as an uncaught 500 (see lib/contact.ts). Parsing precedes any DB access.
  name: storableText(z.string().trim().min(1).max(200)),
  organization: storableText(z.string().trim().max(200)).optional(),
  role: storableText(z.string().trim().max(200)).optional(),
  category: z.enum(DATASET_CATEGORIES),
  intendedUse: storableText(z.string().trim().min(1).max(2000)),
  links: z.array(httpUrlSchema).max(3).default([]),
  attributionAck: z.literal(true),
  termsAccepted: z.literal(true),
  // Deliberately unbounded: isHoneypotTripped trims, so a whitespace-only value over a max would skip the honeypot and 400 (an oracle); the 64 KiB body cap bounds it.
  website: z.string().optional(), // honeypot — real users never fill this; checked on the RAW input before this schema runs
});

export type DatasetRequestInput = z.infer<typeof datasetRequestInputSchema>;

/**
 * The only legal status moves. expired, revoked and rejected are terminal. Used
 * by the admin UI and asserted by tests; the real guard in every mutating
 * function is an atomic `UPDATE ... WHERE status = <from>`, never this table.
 */
const ALLOWED_TRANSITIONS: Record<DatasetGrantStatus, readonly DatasetGrantStatus[]> = {
  unverified: ["pending_review"],
  pending_review: ["active", "rejected"],
  active: ["expired", "revoked"],
  expired: [],
  revoked: [],
  rejected: [],
};

export function canTransition(from: DatasetGrantStatus, to: DatasetGrantStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * What the verify mail shows back to the address owner: the request content exactly as stored with that
 * token, so a stranger's re-request that rotated the token and substituted content is visible to the owner.
 */
export type DatasetRequestEcho = {
  name: string;
  organization: string | null;
  role: string | null;
  category: DatasetCategory;
  intendedUse: string;
  links: string[];
};

/** Built from the SAME `requestFields` object written to the row, so the echo is what was stored. */
const echoOf = (fields: DatasetRequestEcho): DatasetRequestEcho => ({
  name: fields.name,
  organization: fields.organization,
  role: fields.role,
  category: fields.category,
  intendedUse: fields.intendedUse,
  links: fields.links,
});

/**
 * A mail the CALLER should send. The functions in this file never send: the
 * route schedules the gated sender via `after()` so response latency cannot
 * tell a sending path from a generic-success one.
 */
export type DatasetMailIntent =
  | { kind: "dataset_verify"; grantId: string; email: string; verifyToken: string; echo: DatasetRequestEcho } // raw token, for the link only
  | { kind: "dataset_already_active"; grantId: string; email: string } // no token, no rotation
  | { kind: "dataset_admin_new_request"; grantId: string; name: string; organization: string | null } // to the maintainer
  | { kind: "dataset_approved"; grantId: string; email: string; accessToken: string } // raw access token, for the link only
  | { kind: "dataset_rejected"; grantId: string; email: string; rejectionNote: string | null }
  | { kind: "dataset_link_reissued"; grantId: string; email: string; accessToken: string } // the NEW raw access token
  | { kind: "dataset_renewal_reminder"; grantId: string; email: string; renewToken: string }; // raw renew token, for the link only

export type DatasetRequestResult =
  | { ok: true; publicResult: { ok: true }; mail?: DatasetMailIntent }
  | { ok: false; status: 400; error: string; issues?: unknown };

/**
 * The OPEN-grant predicate as SQL text, for the INSERT's `ON CONFLICT (email) WHERE ...` target. The statuses
 * come from `DATASET_OPEN_GRANT_STATUSES` (lib/db/schema.ts), the single source that also builds the predicate
 * of the partial unique index `dataset_access_grants_open_email_idx`: the index allows at most one open row
 * per email, which is what makes the INSERT below race-free. Postgres infers a partial unique index only when
 * the clause's predicate implies the index's, and that proof needs literals: bound parameters (what
 * `inArray` emits) never match. The values are fixed constants, never input.
 */
const OPEN_GRANT_PREDICATE = sql`${datasetAccessGrantsTable.status} in (${sql.raw(
  DATASET_OPEN_GRANT_STATUSES.map((status) => `'${status}'`).join(", ")
)})`;

/**
 * The ONE definition of each lifecycle state of an `active` row, as SQL fragments reused by every
 * query that tests it (WHERE guards and, via `sql<boolean>`, select projections). The states:
 * - LIVE: `expiresAt` set and in the future. The grant works: downloads, renewal requests, new links.
 * - RENEWAL_PENDING: a renewal was requested (before expiry: `requestRenewal` only accepts a LIVE row).
 *   Stays approvable at ANY expiry; downloads are paused once the date passes, until the maintainer
 *   approves (Ed, 2026-11-09).
 * - LAPSED: neither: expiry passed or NULL, and no renewal requested. NULL expiry is lapsed everywhere
 *   (approve always sets it, so such a row is unreachable, but every function must treat it the same way).
 * Every `active` row is LIVE, RENEWAL_PENDING (both, if a renewal was requested while live) or LAPSED.
 */
export const liveGrant = (now: Date): SQL =>
  sql`(${eq(datasetAccessGrantsTable.status, "active")} and ${isNotNull(datasetAccessGrantsTable.expiresAt)} and ${gt(datasetAccessGrantsTable.expiresAt, now)})`;

export const renewalPendingGrant = (): SQL =>
  sql`(${eq(datasetAccessGrantsTable.status, "active")} and ${isNotNull(datasetAccessGrantsTable.renewalRequestedAt)})`;

export const lapsedGrant = (now: Date): SQL =>
  sql`(${eq(datasetAccessGrantsTable.status, "active")} and (${isNull(datasetAccessGrantsTable.expiresAt)} or ${lte(datasetAccessGrantsTable.expiresAt, now)}) and ${isNull(datasetAccessGrantsTable.renewalRequestedAt)})`;

/**
 * How long an `unverified` row must have sat (measured from `createdAt`, which every mint and rotation
 * sets) before another request may rotate it. Rotation is what stops squatting, but without a floor a
 * stranger could keep re-submitting the owner's address and replace the verify token faster than the
 * owner can open the mail, so the owner's link would never stay live. The boundary, stated plainly:
 * - Each mint guarantees the owner's link stays live for at least 20 minutes. The 20 minutes runs from the
 *   MINT, not from delivery.
 * - A double submit inside the cooldown sends nothing new, and the first link still works.
 * - Rotations are spaced 20 minutes apart: at most 4 in any closed hour (3 per rolling hour), so the
 *   per-recipient cap of 5 per hour in `sendGrantGated` (lib/email-gate.ts) does not starve them. That cap
 *   is one budget shared with `dataset_already_active`, which only an address with an active row draws.
 *   The second cap, 10 per 24 h, CAN be exhausted: a stranger rotating every 20 minutes uses it up in about
 *   3 hours, after which the owner's verify mail is refused for the rest of that window (accepted, Ed 2026-11-09).
 * - A stranger can still replace the request's content once the cooldown has passed. A stranger who
 *   re-requests an address about every 20 minutes can keep pre-empting the owner's own submission. The owner's
 *   only link is then the one the stranger's request triggered, which carries the stranger's content until the
 *   verify mail (`buildDatasetVerifyEmail` / `sendDatasetVerifyEmail`, lib/email.ts) echoes the submitted
 *   request content, so the owner sees what is being verified.
 * - No token or data is exposed: the response to the requester is the same generic success either way.
 * - The request route (app/api/access/request/route.ts) sends this mail through `sendGrantGated` (lib/email-gate.ts;
 *   the per-recipient caps) with `sendDatasetVerifyEmail` (lib/email.ts; the echo), via lib/dataset-mail.ts.
 */
export const DATASET_ROTATION_COOLDOWN_MS = 20 * 60 * 1000;

/** Same `publicResult` for every success path, so the response never reveals which case applied. */
const genericSuccess = (): DatasetRequestResult => ({ ok: true, publicResult: { ok: true } });

/**
 * Validates and stages an approved-access dataset request (double opt-in: the
 * requester verifies their address, then the maintainer reviews). Enumeration
 * safety follows `requestAccessGrant` (lib/access-grants.ts): every path that
 * sends the requester nothing new returns the same `publicResult` `{ok:true}`,
 * and the mail intent travels beside it, never in it, so the response body never
 * reveals which case applied. The per-IP limit and the `after()` send live in the
 * route (app/api/access/request/route.ts), not here.
 *
 * Order: honeypot (RAW input) -> parse -> per-address cap -> global suppression
 * (`mayEmail`) -> open-row lookup, then, by the one OPEN row for the address (the
 * partial unique index allows at most one):
 * - none, mailable: `INSERT ... ON CONFLICT DO NOTHING`. A returned row is a
 *   `dataset_verify` intent; no row means a concurrent request won the index, and
 *   that winner sends the one verify mail, so this one is generic with no mail.
 * - none, not mailable: no row, no mail (one read stands in for the INSERT).
 * - `unverified`, mailable: the row is rotated in place, every request field
 *   taken from THIS submission, a new verify token (the old link dies) and
 *   `createdAt` reset (it anchors the verify TTL). This stops squatting: a
 *   stranger's ignored request cannot block the real owner of the address. The
 *   rotation only matches a row at least `DATASET_ROTATION_COOLDOWN_MS` old, so a
 *   request inside the cooldown, or one whose row was verified in the meantime, is
 *   generic with no mail and the previously mailed link stays valid. Not mailable:
 *   generic.
 * - `pending_review`: generic, no mail.
 * - `active`, LIVE or RENEWAL_PENDING (`expiresAt` in the future, or a renewal
 *   requested before it lapsed, which stays approvable): a
 *   `dataset_already_active` intent when mailable (no token minted or rotated).
 * - `active`, LAPSED (`expiresAt` passed or null, no renewal requested): lazily
 *   marked `expired`, then handled as "none" above, so a NEW row is inserted.
 * (LIVE, RENEWAL_PENDING and LAPSED are `liveGrant`, `renewalPendingGrant` and `lapsedGrant`.)
 * Rejected, revoked and expired rows are not open, so that person may request
 * again (a new row).
 *
 * Mail volume: the per-address cap below bounds NEW ROWS per address per window,
 * not mails. Rotation and `dataset_already_active` can mail again for an existing
 * row. Rotation is spaced by `DATASET_ROTATION_COOLDOWN_MS`. The mail itself is
 * capped in `sendGrantGated` (lib/email-gate.ts), where `dataset_verify` and
 * `dataset_already_active` share one budget of 5 per address per hour and 10 per
 * address per 24 h; the route sends through that gate, so both caps apply. They are
 * deliberately not duplicated here.
 */
export async function requestDatasetAccess(
  rawInput: unknown,
  ipHash: string
): Promise<DatasetRequestResult> {
  // Honeypot FIRST, against the RAW input, before the schema runs (see
  // requestAccessGrant). It runs on the raw value so that every non-empty
  // type, a number or an object as well as a string, answers the same generic
  // success. `null`, `false` and `[]` are "present but not filled in": they
  // are not tripped and go through normal validation, so the schema answers
  // 400 for them exactly as it does for a non-string value in any other
  // optional string field (e.g. `organization: null`). That 400 is not an
  // oracle, because every optional string field rejects them the same way.
  if (
    isHoneypotTripped(
      rawInput && typeof rawInput === "object"
        ? { website: (rawInput as { website?: unknown }).website }
        : {}
    )
  ) {
    return genericSuccess();
  }

  const parsed = datasetRequestInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid request", issues: parsed.error.issues };
  }
  const data = parsed.data;
  const email = normalizeEmail(data.email);
  const now = new Date();

  // Per-address cap before any other DB read, so every later path reaches it first.
  if (!(await checkDatasetRequestEmailCap(email)).ok) {
    return genericSuccess(); // over the per-address cap: no row, no mail
  }

  const db = getDb();

  // "Stop all email" covers these automated sends: a stranger can type any
  // address into the form, so a globally stopped address (or one whose lookup
  // failed, "unknown") must get no mail. Always runs, in the same slot for
  // every caller; `mayEmail` is the only sanctioned send decision.
  const mailable = mayEmail(await isSuppressed(db, email, { kind: "global" }));

  const [open] = await db
    .select({
      id: datasetAccessGrantsTable.id,
      status: datasetAccessGrantsTable.status,
      lapsed: sql<boolean>`${lapsedGrant(now)}`, // the shared LAPSED definition, evaluated in the same query
    })
    .from(datasetAccessGrantsTable)
    .where(
      and(eq(datasetAccessGrantsTable.email, email), inArray(datasetAccessGrantsTable.status, DATASET_OPEN_GRANT_STATUSES))
    )
    .limit(1); // the partial unique index guarantees at most one

  // Every request field comes from THIS submission; shared by the INSERT and the unverified rotation.
  const requestFields = {
    name: data.name,
    organization: data.organization || null,
    role: data.role || null,
    category: data.category,
    intendedUse: data.intendedUse,
    links: data.links,
    attributionAckAt: now,
    termsVersion: DATASET_TERMS_VERSION,
    submitterIpHash: ipHash,
  };

  if (open?.status === "pending_review") return genericSuccess();

  if (open?.status === "unverified") {
    if (!mailable) return genericSuccess();

    const verifyToken = generateToken();
    const [rotated] = await db
      .update(datasetAccessGrantsTable)
      .set({
        ...requestFields,
        verifyTokenHash: hashToken(verifyToken), // raw kept only in the local `verifyToken` var, for the email
        createdAt: now, // anchors the verify TTL: a rotated link gets a fresh 7 days
      })
      .where(
        and(
          eq(datasetAccessGrantsTable.id, open.id),
          eq(datasetAccessGrantsTable.status, "unverified"),
          // The cooldown, on the app clock like every other time test here: a younger row keeps its link.
          lte(datasetAccessGrantsTable.createdAt, new Date(now.getTime() - DATASET_ROTATION_COOLDOWN_MS))
        )
      )
      .returning({ id: datasetAccessGrantsTable.id });
    // No row: inside the cooldown (the mailed link stays valid) or verified in between (nothing to re-verify).
    if (!rotated) return genericSuccess();
    return {
      ok: true,
      publicResult: { ok: true },
      mail: { kind: "dataset_verify", grantId: rotated.id, email, verifyToken, echo: echoOf(requestFields) },
    };
  }

  if (open?.status === "active") {
    // Not lapsed: LIVE, or RENEWAL_PENDING (a renewal requested before the date passed stays approvable).
    // Strict `=== false`, never truthiness: `lapsed` is a computed `sql<boolean>` projection that Drizzle
    // does not map, so a driver that hands back anything but a real boolean (a "f" string, null) must not
    // pick the branch that mails. Every other value takes the lapsed branch below, whose UPDATE is
    // SQL-guarded by `lapsedGrant`, so a live row is left intact and the INSERT meets the partial index.
    if (open.lapsed === false) {
      // The already-active mail is bounded by the per-recipient cap in `sendGrantGated` (lib/email-gate.ts;
      // 5 per address per hour and 10 per 24 h, shared with dataset_verify); no cap is added here.
      return mailable
        ? { ok: true, publicResult: { ok: true }, mail: { kind: "dataset_already_active", grantId: open.id, email } }
        : genericSuccess();
    }

    // LAPSED: lazy expiry (the same guard as the sweep and `getGrantByAccessToken`), then fall through
    // to the new-row path. The UPDATE's result is not needed: if it lost a race (renewed, revoked),
    // the INSERT below meets the partial unique index or succeeds, and both outcomes are correct.
    // Best effort, like `getGrantByAccessToken`: if the UPDATE throws, the row stays `active`, the INSERT
    // below meets the partial unique index and conflicts, and the answer is the generic one with no mail.
    try {
      await db
        .update(datasetAccessGrantsTable)
        .set({ status: "expired" })
        .where(and(eq(datasetAccessGrantsTable.id, open.id), lapsedGrant(now)));
    } catch (err) {
      console.error(`dataset lazy expiry failed (sqlstate: ${redactedErrorCode(err)})`);
    }
  }

  // No open row (or the lapsed one was just expired).
  if (!mailable) {
    // No row for an address that can never receive its verify link: it would be
    // dead weight. Query-count symmetry: one read of the same table stands in
    // for the INSERT the other path runs; its result is unused.
    await db
      .select({ id: datasetAccessGrantsTable.id })
      .from(datasetAccessGrantsTable)
      .where(eq(datasetAccessGrantsTable.email, email))
      .limit(1);
    return genericSuccess();
  }

  const verifyToken = generateToken();
  const [row] = await db
    .insert(datasetAccessGrantsTable)
    .values({
      ...requestFields,
      email,
      status: "unverified",
      verifyTokenHash: hashToken(verifyToken), // raw kept only in the local `verifyToken` var, for the email
      createdAt: now, // the app clock, like rotation and the cooldown: one clock anchors the cooldown and the TTL
    })
    // A concurrent request took the one open slot. Scoped to that partial unique index, so a violation of
    // any other unique index (a token hash) is a real error, not silently swallowed as "someone else won".
    .onConflictDoNothing({ target: datasetAccessGrantsTable.email, where: OPEN_GRANT_PREDICATE })
    .returning({ id: datasetAccessGrantsTable.id });
  if (!row) return genericSuccess(); // that winner sends the one verify mail

  return {
    ok: true,
    publicResult: { ok: true },
    mail: { kind: "dataset_verify", grantId: row.id, email, verifyToken, echo: echoOf(requestFields) },
  };
}

/**
 * How long a verify link works, measured from the row's `createdAt`. Meant to match the
 * planned U9 retention prune of unverified rows older than 7 days (not built yet), and a rotated request
 * (`requestDatasetAccess` on an unverified row) resets `createdAt`, so a new link
 * always gets the full term.
 */
export const DATASET_VERIFY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type VerifyDatasetRequestResult =
  | { outcome: "verified"; mail?: DatasetMailIntent }
  | { outcome: "invalid" };

/**
 * Consumes a single-use verify token: `unverified` -> `pending_review`, stamping
 * `verifiedAt`, and hands back the maintainer notice for the caller to send.
 * The atomic `UPDATE ... WHERE status = 'unverified'` (and not older than
 * `DATASET_VERIFY_TTL_MS`) is the guard, so two
 * concurrent verifies yield exactly one notice. A repeat of an already-consumed
 * token (an email scanner's prefetch, a double click) still reads "verified"
 * but carries NO notice, so it can never re-notify the maintainer. These tables
 * never stored raw tokens, so there is no legacy raw-token fallback.
 */
export async function verifyDatasetRequest(rawToken: string): Promise<VerifyDatasetRequestResult> {
  // Shape check BEFORE any DB call: a malformed value can never match a hash.
  if (!DATASET_TOKEN_RE.test(rawToken)) {
    return { outcome: "invalid" };
  }

  const db = getDb();
  const verifyTokenHash = hashToken(rawToken);
  const now = new Date();

  const [verified] = await db
    .update(datasetAccessGrantsTable)
    .set({ status: "pending_review", verifiedAt: now })
    .where(
      and(
        eq(datasetAccessGrantsTable.verifyTokenHash, verifyTokenHash),
        eq(datasetAccessGrantsTable.status, "unverified"),
        gt(datasetAccessGrantsTable.createdAt, new Date(now.getTime() - DATASET_VERIFY_TTL_MS))
      )
    )
    .returning({
      id: datasetAccessGrantsTable.id,
      name: datasetAccessGrantsTable.name,
      organization: datasetAccessGrantsTable.organization,
    });
  if (verified) {
    return {
      outcome: "verified",
      mail: {
        kind: "dataset_admin_new_request",
        grantId: verified.id,
        name: verified.name,
        organization: verified.organization,
      },
    };
  }

  const [existing] = await db
    .select({ verifiedAt: datasetAccessGrantsTable.verifiedAt })
    .from(datasetAccessGrantsTable)
    .where(eq(datasetAccessGrantsTable.verifyTokenHash, verifyTokenHash))
    .limit(1);
  return existing?.verifiedAt ? { outcome: "verified" } : { outcome: "invalid" };
}

/** Length of a grant: approval, renewal and an admin extension all set `expires_at = now + term`. */
export const DATASET_GRANT_TERM_MS = 365 * 24 * 60 * 60 * 1000;

const NOTE_MAX_CODE_POINTS = 2000;

/**
 * Free-text admin notes: NUL and unpaired surrogates removed (Postgres text rejects NUL; a lone surrogate
 * cannot be stored), trimmed, empty becomes null, capped at 2000 CODE POINTS so the cap never splits a pair.
 */
export function normalizeDatasetNote(note: string | null | undefined): string | null {
  if (!note) return null;
  // `Array.from` walks code points: a valid pair is one element, a lone surrogate is an element of its own,
  // and `hasUnstorableChars` flags exactly NUL and those lone halves. Trimming comes last so whitespace
  // exposed by a removal cannot survive at the edges.
  const cleaned = Array.from(note)
    .filter((codePoint) => !hasUnstorableChars(codePoint))
    .join("")
    .trim();
  return cleaned ? Array.from(cleaned).slice(0, NOTE_MAX_CODE_POINTS).join("") : null;
}

export type MailOf<K extends DatasetMailIntent["kind"]> = Extract<DatasetMailIntent, { kind: K }>;

/** Failure of every admin mutator: a missing row, the wrong status, or an id that is not a UUID. */
export type DatasetGrantNotEligible = { ok: false; reason: "not_eligible" };
// One shared object for every failure, frozen so a caller that mutates a result cannot poison the next one.
const NOT_ELIGIBLE: DatasetGrantNotEligible = Object.freeze({ ok: false, reason: "not_eligible" });

const grantIdSchema = z.string().uuid();

/** Checked BEFORE any DB call: a malformed id must never reach Postgres, where it would raise 22P02. */
const isGrantId = (id: string): boolean => grantIdSchema.safeParse(id).success;

/** A fresh term from `now`; clears the renewal bookkeeping. Shared by approval (both shapes) and `extendDatasetGrant`. */
function extensionFields(now: Date) {
  return {
    expiresAt: new Date(now.getTime() + DATASET_GRANT_TERM_MS),
    renewalRequestedAt: null,
    renewalRemindedAt: null,
    renewTokenHash: null,
  };
}

/**
 * Admin approval, in two shapes that the atomic UPDATEs tell apart. From
 * `pending_review` it activates the grant: mints the raw access token (hashed
 * for storage; the raw value exists ONLY in the returned mail intent), the raw
 * unsubscribe token (raw by the subscriptions precedent) and a 365-day expiry.
 * Otherwise, on a RENEWAL_PENDING grant (`active` with a renewal request
 * outstanding, at ANY expiry: a request made before the date stays approvable
 * after it), it approves the renewal: a fresh term, the renewal bookkeeping
 * cleared, the access token UNCHANGED and no mail (so a link that paused at
 * expiry works again); the existing `reviewNote` is kept unless
 * a new note is supplied. Anything else is `not_eligible`; two
 * concurrent approves of one grant mint exactly one token. Delivery of the mail
 * lives in the caller (planned: U4 admin actions); no per-IP limit applies here.
 */
export async function approveDatasetGrant(
  id: string,
  opts: { reviewNote?: string } = {}
): Promise<
  | { ok: true; kind: "approved"; mail: MailOf<"dataset_approved"> }
  | { ok: true; kind: "renewed" }
  | DatasetGrantNotEligible
> {
  if (!isGrantId(id)) return NOT_ELIGIBLE;

  const db = getDb();
  const now = new Date();
  const reviewNote = normalizeDatasetNote(opts.reviewNote);

  const accessToken = generateToken();
  const [approved] = await db
    .update(datasetAccessGrantsTable)
    .set({
      status: "active",
      accessTokenHash: hashToken(accessToken),
      unsubscribeToken: generateToken(),
      approvedAt: now,
      reviewedAt: now,
      reviewNote,
      ...extensionFields(now), // a fresh term; the renewal bookkeeping of a never-renewed row is already empty
    })
    .where(and(eq(datasetAccessGrantsTable.id, id), eq(datasetAccessGrantsTable.status, "pending_review")))
    .returning({ id: datasetAccessGrantsTable.id, email: datasetAccessGrantsTable.email });
  if (approved) {
    return {
      ok: true,
      kind: "approved",
      mail: { kind: "dataset_approved", grantId: approved.id, email: approved.email, accessToken },
    };
  }

  const [renewed] = await db
    .update(datasetAccessGrantsTable)
    // A renewal with no new note keeps the note from the original approval; only a supplied note replaces it.
    .set({ ...extensionFields(now), reviewedAt: now, ...(reviewNote !== null ? { reviewNote } : {}) })
    .where(and(eq(datasetAccessGrantsTable.id, id), renewalPendingGrant()))
    .returning({ id: datasetAccessGrantsTable.id });
  return renewed ? { ok: true, kind: "renewed" } : NOT_ELIGIBLE;
}

/**
 * Admin rejection: `pending_review` -> `rejected` (terminal). `reviewNote` is
 * internal; `rejectionNote` is shown to the requester via the returned mail
 * intent. Delivery lives in the caller (planned: U4 admin actions).
 */
export async function rejectDatasetGrant(
  id: string,
  opts: { reviewNote?: string; rejectionNote?: string } = {}
): Promise<{ ok: true; mail: MailOf<"dataset_rejected"> } | DatasetGrantNotEligible> {
  if (!isGrantId(id)) return NOT_ELIGIBLE;

  const rejectionNote = normalizeDatasetNote(opts.rejectionNote);
  const [rejected] = await getDb()
    .update(datasetAccessGrantsTable)
    .set({
      status: "rejected",
      reviewedAt: new Date(),
      reviewNote: normalizeDatasetNote(opts.reviewNote),
      rejectionNote,
    })
    .where(and(eq(datasetAccessGrantsTable.id, id), eq(datasetAccessGrantsTable.status, "pending_review")))
    .returning({ id: datasetAccessGrantsTable.id, email: datasetAccessGrantsTable.email });
  if (!rejected) return NOT_ELIGIBLE;

  return { ok: true, mail: { kind: "dataset_rejected", grantId: rejected.id, email: rejected.email, rejectionNote } };
}

/**
 * Admin revocation: `active` -> `revoked` (terminal). No mail. The access token
 * hash is KEPT, so a later lookup of the old link resolves to an inactive grant
 * (`getGrantByAccessToken`) rather than to nothing.
 */
export async function revokeDatasetGrant(
  id: string,
  opts: { reason?: string } = {}
): Promise<{ ok: true } | DatasetGrantNotEligible> {
  if (!isGrantId(id)) return NOT_ELIGIBLE;

  const [revoked] = await getDb()
    .update(datasetAccessGrantsTable)
    .set({ status: "revoked", revokedAt: new Date(), revokeReason: normalizeDatasetNote(opts.reason) })
    .where(and(eq(datasetAccessGrantsTable.id, id), eq(datasetAccessGrantsTable.status, "active")))
    .returning({ id: datasetAccessGrantsTable.id });
  return revoked ? { ok: true } : NOT_ELIGIBLE;
}

/**
 * Admin "send a new link": rotates the access token of a LIVE grant (`active`
 * AND not yet expired); the old link stops working at once. Only the new hash
 * is stored; the raw token exists only in the returned mail intent. Delivery
 * lives in the caller (planned: U4 admin actions).
 */
export async function reissueDatasetLink(
  id: string
): Promise<{ ok: true; mail: MailOf<"dataset_link_reissued"> } | DatasetGrantNotEligible> {
  if (!isGrantId(id)) return NOT_ELIGIBLE;

  const accessToken = generateToken();
  const [reissued] = await getDb()
    .update(datasetAccessGrantsTable)
    .set({ accessTokenHash: hashToken(accessToken) })
    .where(and(eq(datasetAccessGrantsTable.id, id), liveGrant(new Date())))
    .returning({ id: datasetAccessGrantsTable.id, email: datasetAccessGrantsTable.email });
  if (!reissued) return NOT_ELIGIBLE;

  return {
    ok: true,
    mail: { kind: "dataset_link_reissued", grantId: reissued.id, email: reissued.email, accessToken },
  };
}

/**
 * Admin extension: gives a LIVE or RENEWAL_PENDING grant a fresh term from now
 * and clears any outstanding renewal request, reminder and renew token. No mail.
 * A LAPSED grant (past expiry, no renewal requested) is `not_eligible` whether or
 * not a sweep has marked it `expired` yet. Renewal approval (`approveDatasetGrant`)
 * shares the same field set.
 */
export async function extendDatasetGrant(id: string): Promise<{ ok: true } | DatasetGrantNotEligible> {
  if (!isGrantId(id)) return NOT_ELIGIBLE;

  const now = new Date();
  const [extended] = await getDb()
    .update(datasetAccessGrantsTable)
    .set(extensionFields(now))
    .where(and(eq(datasetAccessGrantsTable.id, id), or(liveGrant(now), renewalPendingGrant())))
    .returning({ id: datasetAccessGrantsTable.id });
  return extended ? { ok: true } : NOT_ELIGIBLE;
}

/**
 * Mints the renewal-link token for a LIVE grant (a renewal is requested before
 * expiry), replacing any earlier one (the old link stops working). Only the
 * hash is stored. Deliberately does NOT set `renewalRemindedAt`: the reminder
 * cron (planned: U8 cron) sets it after a confirmed send, so a failed send is retried.
 * Delivery lives in the caller.
 */
export async function issueRenewalToken(
  id: string
): Promise<{ ok: true; mail: MailOf<"dataset_renewal_reminder"> } | DatasetGrantNotEligible> {
  if (!isGrantId(id)) return NOT_ELIGIBLE;

  const renewToken = generateToken();
  const [issued] = await getDb()
    .update(datasetAccessGrantsTable)
    .set({ renewTokenHash: hashToken(renewToken) })
    .where(and(eq(datasetAccessGrantsTable.id, id), liveGrant(new Date())))
    .returning({ id: datasetAccessGrantsTable.id, email: datasetAccessGrantsTable.email });
  if (!issued) return NOT_ELIGIBLE;

  return {
    ok: true,
    mail: { kind: "dataset_renewal_reminder", grantId: issued.id, email: issued.email, renewToken },
  };
}

/**
 * The requester's click on the renewal link: stamps `renewalRequestedAt` for the
 * maintainer's queue. Idempotent, because email scanners prefetch links: a repeat
 * reads "requested" and leaves the first timestamp in place (the atomic UPDATE
 * only matches while it is still NULL). The token is not consumed; approval
 * clears it. A malformed or unknown token, or one whose grant is not LIVE, is
 * "invalid": a renewal must be requested BEFORE expiry. The idempotent repeat is
 * the exception: a grant that already has a renewal request (RENEWAL_PENDING)
 * reads "requested" even past expiry, because that request was made in time.
 * The per-IP limit lives in app/api/access/renew/route.ts; the renewal page is planned for U3b (not built yet).
 */
export async function requestRenewal(
  rawRenewToken: string
): Promise<{ outcome: "requested" } | { outcome: "invalid" }> {
  // Shape check BEFORE any DB call: a malformed value can never match a hash.
  if (!DATASET_TOKEN_RE.test(rawRenewToken)) {
    return { outcome: "invalid" };
  }

  const db = getDb();
  const renewTokenHash = hashToken(rawRenewToken);
  const now = new Date();

  const [requested] = await db
    .update(datasetAccessGrantsTable)
    .set({ renewalRequestedAt: now })
    .where(
      and(
        eq(datasetAccessGrantsTable.renewTokenHash, renewTokenHash),
        liveGrant(now),
        isNull(datasetAccessGrantsTable.renewalRequestedAt)
      )
    )
    .returning({ id: datasetAccessGrantsTable.id });
  if (requested) return { outcome: "requested" };

  // The idempotent repeat: already requested (in time, since only a LIVE row accepts a request).
  const [pending] = await db
    .select({ id: datasetAccessGrantsTable.id })
    .from(datasetAccessGrantsTable)
    .where(and(eq(datasetAccessGrantsTable.renewTokenHash, renewTokenHash), renewalPendingGrant()))
    .limit(1);
  return pending ? { outcome: "requested" } : { outcome: "invalid" };
}

/** The only fields a download page may learn about a grant. Deliberately no hashes, email, IP hash or notes. */
export type DatasetActiveGrant = { id: string; name: string; organization: string | null; expiresAt: Date };

/**
 * Resolves a raw access token to its grant. "Active" means the grant is LIVE
 * (status `active` AND a non-null `expiresAt` still in the future); every other
 * case (unknown, malformed, unverified, pending_review, rejected, revoked,
 * expired, RENEWAL_PENDING past its expiry) returns the SAME
 * `{ state: "inactive" }`, so the caller cannot tell them apart. Only the
 * `DatasetActiveGrant` fields are RETURNED, never the row: no token hash, email,
 * IP hash or internal note can reach a caller that serialises it. (`status` and
 * `live` are also selected, but only for the decision here and the lazy expiry;
 * neither leaves the function.)
 * A LAPSED grant (past expiry or NULL expiry, no renewal requested) is flipped to
 * `expired` here (lazy expiry; `expireDueGrants` is the sweep for the ones nobody
 * opens), best effort: a failed flip is logged by SQLSTATE and the answer is still
 * "inactive". A RENEWAL_PENDING grant past its expiry is NOT expired: downloads
 * pause until the maintainer approves the renewal, which revives the same link.
 * The per-IP limit lives in the caller.
 */
export async function getGrantByAccessToken(
  rawToken: string
): Promise<{ state: "active"; grant: DatasetActiveGrant } | { state: "inactive" }> {
  // Shape check BEFORE any DB call: a malformed value can never match a hash.
  if (!DATASET_TOKEN_RE.test(rawToken)) {
    return { state: "inactive" };
  }

  const db = getDb();
  const now = new Date();
  const [row] = await db
    .select({
      id: datasetAccessGrantsTable.id,
      name: datasetAccessGrantsTable.name,
      organization: datasetAccessGrantsTable.organization,
      expiresAt: datasetAccessGrantsTable.expiresAt,
      status: datasetAccessGrantsTable.status,
      live: sql<boolean>`${liveGrant(now)}`, // the shared LIVE definition, evaluated in the same query
    })
    .from(datasetAccessGrantsTable)
    .where(eq(datasetAccessGrantsTable.accessTokenHash, hashToken(rawToken)))
    .limit(1);
  if (!row) return { state: "inactive" };

  // LIVE implies a non-null `expiresAt`; the second test only narrows the type. Strict `=== true`, never
  // truthiness: `live` is a computed `sql<boolean>` projection that Drizzle does not map, so a driver that
  // hands back a "f" string for a revoked grant would otherwise read as live, and this is the download gate.
  if (row.live === true && row.expiresAt) {
    return {
      state: "active",
      grant: { id: row.id, name: row.name, organization: row.organization, expiresAt: row.expiresAt },
    };
  }

  if (row.status === "active") {
    // Lazy expiry, guarded by the shared LAPSED definition: a RENEWAL_PENDING row matches nothing here.
    try {
      await db
        .update(datasetAccessGrantsTable)
        .set({ status: "expired" })
        .where(and(eq(datasetAccessGrantsTable.id, row.id), lapsedGrant(now)));
    } catch (err) {
      // Best effort: the sweep will catch it, and the visitor's answer is "inactive" either way.
      console.error(`dataset lazy expiry failed (sqlstate: ${redactedErrorCode(err)})`);
    }
  }
  return { state: "inactive" };
}

/**
 * Sweep: every LAPSED grant (`active`, `expiresAt` at or before `now` or NULL, no
 * renewal requested) becomes `expired`; returns how many. A RENEWAL_PENDING grant
 * is skipped even past its expiry: it stays approvable. One atomic UPDATE, so
 * overlapping runs never double-count a row. Scheduling lives in the caller (planned: U8 cron).
 */
export async function expireDueGrants(now: Date = new Date()): Promise<number> {
  const expired = await getDb()
    .update(datasetAccessGrantsTable)
    .set({ status: "expired" })
    .where(lapsedGrant(now))
    .returning({ id: datasetAccessGrantsTable.id });
  return expired.length;
}
