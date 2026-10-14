import { DrizzleQueryError } from "drizzle-orm/errors";

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

const MAX_CAUSE_DEPTH = 5;
const MAX_NODES = 25;

/**
 * True when `err` or anything reachable through its `.cause` chain or an
 * `AggregateError`'s `.errors[]` is a DB error whose message can embed bound
 * query params (drizzle's `Failed query: … params: …`). Bounded to
 * MAX_CAUSE_DEPTH layers and MAX_NODES (25) distinct object nodes, and cycle-safe.
 */
function isDbError(err: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: Array<{ layer: unknown; depth: number }> = [
    { layer: err, depth: 0 },
  ];
  while (queue.length > 0 && seen.size < MAX_NODES) {
    const { layer, depth } = queue.shift()!;
    if (layer === null || typeof layer !== "object" || seen.has(layer))
      continue;
    seen.add(layer);
    if (layer instanceof DrizzleQueryError) return true;
    const { name, message, cause, errors } = layer as {
      name?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (name === "DrizzleQueryError" || name === "NeonDbError") return true;
    if (
      typeof message === "string" &&
      (message.includes("Failed query:") || message.includes("\nparams:"))
    ) {
      return true;
    }
    if (depth + 1 >= MAX_CAUSE_DEPTH) continue;
    queue.push({ layer: cause, depth: depth + 1 });
    if (Array.isArray(errors)) {
      for (const e of errors) queue.push({ layer: e, depth: depth + 1 });
    }
  }
  return false;
}

/**
 * Render a fatal error for a script entrypoint's `main().catch` handler.
 *
 * WHY: those handlers used to `console.error(err)`, which for a drizzle
 * failure dumps `Failed query: <sql> params: <bound values>` — and `run.sh`
 * appends lane stderr to `discovery-logs/*.err`, while `scripts/export.ts`
 * runs in CI, so the params were persisted or published. A DB error (on the
 * error itself or anywhere on its `.cause` chain) is therefore rendered as the
 * SQLSTATE plus ONLY the `    at …` stack frames: a drizzle message spans
 * several lines, so any non-frame stack line may carry params. Other errors
 * keep today's full stack, because nightly lanes need the message to be
 * debuggable. Every branch's output is scrubbed of URI credentials (see
 * `scrubUriCredentials`: the `neon()` invalid-URL message embeds the raw
 * connection string). Never throws.
 */
export function formatFatalError(err: unknown): string {
  try {
    return scrubUriCredentials(renderFatalError(err));
  } catch {
    return "unprintable error";
  }
}

/**
 * Strip `user:password@` from any `scheme://` URI in `text`, keeping the host.
 * Greedy up to the LAST `@` before whitespace or a quote, so a password holding
 * a raw `@` or `/` is still covered; over-redacting a path with `@` is fine.
 * WHY: a non-DB error can still carry a secret — `neon()` throws "Database
 * connection string provided to neon() is not a valid URL (connection string:
 * <raw string>)" for a quoted `DATABASE_URL`, password included. Applied to
 * the final output of every branch of `formatFatalError`.
 */
function scrubUriCredentials(text: string): string {
  return text.replace(/[^\s'"`]+/g, scrubToken);
}

/**
 * One whitespace/quote-delimited token. Linear by construction (a single
 * indexOf + lastIndexOf), unlike a backtracking regex, which went quadratic on
 * "a://a://…". Redacts everything between `://` and the LAST `@`, so a
 * password containing `@` or `/` is covered; over-redaction is acceptable.
 */
function scrubToken(token: string): string {
  const i = token.indexOf("://");
  if (i < 0) return token;
  const at = token.lastIndexOf("@");
  if (at > i + 2) return token.slice(0, i + 3) + "<redacted>" + token.slice(at);
  return token;
}

function renderFatalError(err: unknown): string {
  if (isDbError(err)) {
    const name =
      typeof (err as { name?: unknown })?.name === "string"
        ? (err as { name: string }).name
        : "Error";
    const stack =
      typeof (err as { stack?: unknown })?.stack === "string"
        ? (err as { stack: string }).stack
        : "";
    const message = (err as { message?: unknown })?.message;
    const header = `${name}: ${typeof message === "string" ? message : ""}`;
    // Drop the "<name>: <message>" header BEFORE filtering to frames: a bound
    // param holding "\n    at x" would otherwise pass the frame filter. If the
    // stack does not start with that header we cannot tell message from frame,
    // so emit no frames at all.
    const head = `${name}: database error (sqlstate: ${redactedErrorCode(err)}) — message redacted (it can embed bound query params)`;
    if (!stack.startsWith(header)) {
      return `${head}\n(stack frames omitted: header mismatch)`;
    }
    const frames = stack
      .slice(header.length)
      .split("\n")
      .filter((line) => /^\s+at /.test(line));
    return [head, ...frames].join("\n");
  }
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}
