/**
 * Shared redaction helper for DB catch blocks.
 *
 * WHY THIS EXISTS: drizzle-orm wraps every driver error in a
 * `DrizzleQueryError` whose own `.message` has the form
 * `Failed query: <sql> params: <bound values>` — so the error object EMBEDS
 * the query's bound params. Logging `err`, `err.message`, `String(err)` or
 * anything that stringifies the error puts those params into Vercel Runtime
 * Logs: a subscriber's plaintext email, a visitor's search text, an IP hash,
 * or (in `lib/api-daily-limit.ts`'s legacy raw-token lookup) a live bearer
 * token. The error object must never be logged.
 *
 * WHAT CALLERS LOG INSTEAD: the Postgres SQLSTATE **only** — a discriminator
 * that carries everything an operator needs (e.g. 42P01 = table missing, i.e.
 * the migration has not been applied; 08006 = connection failure) and nothing
 * about the caller. The established call-site format is:
 *
 *     console.warn(`…existing message… (sqlstate: ${redactedErrorCode(err)})`)
 *
 * THIS IS THE SHARED HELPER EVERY DB CATCH BLOCK MUST USE. It was previously a
 * private copy inside `lib/subscribe.ts`, which is exactly why five sibling
 * call sites kept logging the raw error — do not re-privatise it or fork
 * another copy; import it here.
 *
 * It walks the same `err`/`err.cause` layers as `isUniqueViolation` in
 * `lib/subscribe.ts`, because drizzle's own wrapper carries no `code` — the
 * real driver `code` lives one level down on `.cause`. Returns "unknown" when
 * neither layer carries one (e.g. a plain `Error` thrown by our own code):
 * deliberately NOT the message, which would defeat the point.
 */
export function redactedErrorCode(err: unknown): string {
  const layers = [err, err instanceof Error ? err.cause : undefined];
  for (const layer of layers) {
    const code = (layer as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "unknown";
}
