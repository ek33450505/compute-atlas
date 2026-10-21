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
 *     console.warn(`…existing message… (${codeLabel(headerCode(err, node))})`)
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
 *
 * A code is returned only if it is a bare token (`CODE_PATTERN`,
 * `/^[A-Z0-9_]{2,40}$/`), so a `code` property that someone filled with free
 * text can never reach a log. This is deliberately NOT a strict five-character
 * SQLSTATE test: that would regress the neon-http driver and discard
 * `ENOTFOUND` / `ECONNREFUSED` / `UND_ERR_CONNECT_TIMEOUT`, and `ENOTFOUND` is
 * this project's outage-vs-link-rot discriminator. Anything else is "unknown".
 *
 * The code is the first identifier-shaped one found by the same bounded walk
 * the classifier uses (`collectCodes`): the error, then its `.cause` chain and
 * `AggregateError.errors[]`. So `new Error("lane failed", { cause: drizzleErr })`
 * still reports the driver's `42P01` from one layer down.
 */
export function redactedErrorCode(err: unknown): string {
  return collectCodes(err, 1)[0] ?? "unknown";
}

/** A bare identifier-like code: Postgres SQLSTATEs and Node/undici network codes both fit. */
const CODE_PATTERN = /^[A-Z0-9_]{2,40}$/;

/**
 * Postgres SQLSTATE shape: five chars, `[0-9A-Z]`, NOT starting with `E`. The
 * `E` exclusion is what keeps Node errno codes (`EPIPE`, `EBUSY`, `EPERM`,
 * `EBADF`, `ENXIO`, all five letters) from being misread as database errors;
 * the SQLSTATE classes that start with `E` do not occur in what drivers throw
 * here. A raw pg error echoes its bound value in the message
 * (`invalid input syntax for type uuid: "a@b.com"`) with no Drizzle wrapper, so
 * its code is the only reliable tell.
 */
const SQLSTATE_PATTERN = /^[0-9A-DF-Z][0-9A-Z]{4}$/;

const MAX_CAUSE_DEPTH = 5;
const MAX_NODES = 25;

const looksLikeDbText = (text: string): boolean =>
  text.includes("Failed query:") ||
  text.includes("\nparams:") ||
  // Raw pg echo of a bound value: `invalid input syntax for type uuid: "a@b.com"`.
  text.includes("invalid input syntax for type") ||
  // Postgres unique-violation detail, e.g. `DETAIL: Key (email)=(a@b.com) already exists.`
  text.includes("DETAIL:") ||
  (text.includes("Key (") && text.includes(") already exists"));

/** Max children enqueued per node; a longer `errors[]` trips the fail-closed path. */
const MAX_CHILDREN = 25;

type DbClass = "db" | "possible" | "limit" | false;

/** `node` is the layer classified as DB (absent for a DB-text string or a bound-only result). */
interface DbInspection {
  kind: DbClass;
  node?: object;
}

/** A name or key that suggests a DB layer without proving one. */
const DB_NAME_HINT = /drizzle|neon|postgres|sql/i;

/**
 * Classifies `err` and returns the node it classified as DB (`node`, used for
 * header-code provenance; absent for a DB-text string or a bound-only result).
 * STRONG evidence (a Drizzle/Neon wrapper, `query`+`params`, DB text) returns
 * immediately with that layer. SQLSTATE-shaped `.code` alone is WEAK: the first
 * such layer is remembered and returned only if the walk finds nothing
 * stronger, so an outer wrapper whose code merely looks like a SQLSTATE does not
 * take provenance from the real DB layer below it.
 *
 * Kinds:
 *   - `"db"`: it, or anything reachable through its `.cause` chain or an
 *     `AggregateError`'s `.errors[]`, is a DB error whose message can embed
 *     bound query params (drizzle's `Failed query: … params: …`, a Postgres
 *     `DETAIL:` line), an object carrying both `query` and `params`, or a
 *     thrown/nested primitive string carrying such text.
 *   - `"possible"` / `"limit"`: no DB error was found, but a bound was hit with
 *     parts uninspected: MAX_CAUSE_DEPTH layers, MAX_NODES (25) object nodes, or
 *     MAX_CHILDREN per node. FAILS CLOSED: callers redact it like `"db"`, with
 *     an honest label. `"possible"` means something DB-ish was seen (a
 *     drizzle/neon/postgres/sql name, a `query`, `params` or `severity` key);
 *     `"limit"` means no evidence at all, so the label stays neutral.
 *   - Also `"db"`: any layer whose `.code` has SQLSTATE shape (`SQLSTATE_PATTERN`).
 *   - `false`: fully inspected, nothing DB-shaped.
 * Cycle-safe; the queue is walked by index, not `shift()`.
 */
function inspectDbError(err: unknown): DbInspection {
  const seen = new Set<unknown>();
  const queue: Array<{ layer: unknown; depth: number }> = [{ layer: err, depth: 0 }];
  let head = 0;
  let possible = false;
  let hint = false;
  let weak: object | undefined;
  const isWalkable = (c: unknown) => typeof c === "string" || (c !== null && typeof c === "object");

  while (head < queue.length && seen.size < MAX_NODES) {
    const { layer, depth } = queue[head++];
    if (typeof layer === "string") {
      if (looksLikeDbText(layer)) return { kind: "db" };
      continue;
    }
    if (layer === null || typeof layer !== "object" || seen.has(layer)) continue;
    seen.add(layer);
    if (layer instanceof DrizzleQueryError) return { kind: "db", node: layer };
    const { name, message, cause, errors } = layer as {
      name?: unknown;
      message?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (name === "DrizzleQueryError" || name === "NeonDbError") return { kind: "db", node: layer };
    if ("query" in layer && "params" in layer) return { kind: "db", node: layer };
    const layerCode = (layer as { code?: unknown }).code;
    // Shape-only evidence is WEAK: remember it but keep looking, so a stronger
    // node (Drizzle wrapper, DB text) deeper down wins provenance over an outer
    // wrapper whose own code merely looks like a SQLSTATE.
    if (typeof layerCode === "string" && SQLSTATE_PATTERN.test(layerCode)) weak ??= layer;
    if (
      (typeof name === "string" && DB_NAME_HINT.test(name)) ||
      "query" in layer ||
      "params" in layer ||
      "severity" in layer
    ) {
      hint = true;
    }
    if (typeof message === "string" && looksLikeDbText(message)) return { kind: "db", node: layer };
    const list = Array.isArray(errors) ? errors : [];
    if (list.length > MAX_CHILDREN) possible = true;
    const children = [cause, ...list.slice(0, MAX_CHILDREN)];
    if (depth + 1 >= MAX_CAUSE_DEPTH) {
      // Depth cap: anything we would have walked into is uninspected.
      for (const c of children) {
        if (typeof c === "string" ? looksLikeDbText(c) : isWalkable(c)) {
          if (typeof c === "string") return { kind: "db" };
          possible = true;
        }
      }
      continue;
    }
    for (const child of children) queue.push({ layer: child, depth: depth + 1 });
  }
  // Node cap: whatever is still queued was never inspected.
  for (; head < queue.length; head++) {
    const { layer } = queue[head];
    if (typeof layer === "string") {
      if (looksLikeDbText(layer)) return { kind: "db" };
    } else if (typeof layer === "object" && layer !== null && !seen.has(layer)) {
      possible = true;
    }
  }
  if (weak) return { kind: "db", node: weak };
  if (!possible) return { kind: false };
  return { kind: hint ? "possible" : "limit" };
}

/**
 * Render a fatal error for a script entrypoint's `main().catch` handler.
 *
 * WHY: those handlers used to `console.error(err)`, which for a drizzle
 * failure dumps `Failed query: <sql> params: <bound values>` — and `run.sh`
 * appends lane stderr to `discovery-logs/*.err`, while `scripts/export.ts`
 * runs in CI, so the params were persisted or published. A DB error (on the
 * error itself or anywhere on its `.cause` chain) is therefore rendered as the
 * SQLSTATE plus ONLY the `    at …` stack frames (`inspectDbError` fails closed
 * at its depth/node/children bounds, so an over-deep or over-wide chain is
 * redacted too): a drizzle message spans
 * several lines, so any non-frame stack line may carry params. Other errors
 * keep today's full stack, because nightly lanes need the message to be
 * debuggable. Every branch's output is scrubbed of URI credentials
 * (`scheme://user:pass@` only; plain-text bearer tokens and API keys are NOT
 * detected, so never put one in an error message) (see
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
 * Two passes. First a whole-text pass that redacts from `scheme://` up to the
 * FIRST `@` (at most 200 non-whitespace chars), so it may cross quote
 * characters. Then `scrubToken` per whitespace/quote-delimited token, which is
 * greedy up to that token's LAST `@`, so a password holding a raw `@` or `/` is
 * still covered; over-redacting a path with `@` is fine.
 * WHY: a non-DB error can still carry a secret — `neon()` throws "Database
 * connection string provided to neon() is not a valid URL (connection string:
 * <raw string>)" for a quoted `DATABASE_URL`, password included. Applied to
 * the final output of every branch of `formatFatalError`. Only URI credentials
 * (`scheme://user:pass@`) are scrubbed: a thrown primitive string carrying an
 * email or any other PII, a bearer token or an API key in plain text is printed
 * as-is. The helpers redact DB params and URI credentials, not arbitrary PII.
 */
function scrubUriCredentials(text: string): string {
  // Whole-text pass first: it may cross quote characters (`p"w` in a password).
  // Scheme length is bounded so the scan stays linear on long alphanumeric
  // runs. An unencoded SPACE in a password is still NOT covered.
  const wholeText = text.includes("://")
    ? text.replace(/([a-z][a-z0-9+.-]{0,30}:\/\/)[^@\s]{0,200}@/gi, "$1<redacted>@")
    : text;
  return wholeText.replace(/[^\s'"`]+/g, scrubToken);
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

/** A class name, or "Error" when `name` is anything that could carry data. */
function safeName(err: unknown): string {
  const name = (err as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" && SAFE_TOKEN.test(name) ? name : "Error";
}

/**
 * The code a DB header reports, by PROVENANCE rather than shape:
 *   1. the `CODE_PATTERN` code on the node classified as DB (`inspection.node`);
 *   2. failing that, the code on that node's direct `.cause` (a DrizzleQueryError
 *      carries none of its own; the driver error below it does);
 *   3. failing that, the first `CODE_PATTERN` code on the bounded walk;
 *   4. else "unknown".
 * So an outer wrapper's own code (`ABORT`, `EPIPE`) cannot hide the driver's
 * SQLSTATE. The standalone `redactedErrorCode` stays outermost-first on purpose:
 * the `ENOTFOUND` outage signal relies on that. Never returns a value outside
 * `CODE_PATTERN`.
 */
function headerCode(err: unknown, node?: object): string {
  const own = (layer: unknown): string | undefined => {
    const code = (layer as { code?: unknown } | null | undefined)?.code;
    return typeof code === "string" && CODE_PATTERN.test(code) ? code : undefined;
  };
  if (node) {
    const fromNode = own(node) ?? own((node as { cause?: unknown }).cause);
    if (fromNode) return fromNode;
  }
  return collectCodes(err, 1)[0] ?? "unknown";
}

/** `sqlstate: X` only when X really has SQLSTATE shape; `code: X` for any other token. */
function codeLabel(code: string): string {
  return code === "unknown" || SQLSTATE_PATTERN.test(code) ? `sqlstate: ${code}` : `code: ${code}`;
}

/** The redacted header both helpers emit for a DB (or possibly-DB) error. */
function redactedHeader(err: unknown, kind: Exclude<DbClass, false>, node?: object): string {
  if (kind === "limit") {
    return `${safeName(err)}: inspection limit reached — message redacted (it may embed bound query params)`;
  }
  const label =
    kind === "db" ? "database error" : "possible database error (inspection limit reached)";
  return `${safeName(err)}: ${label} (${codeLabel(headerCode(err, node))}) — message redacted (it can embed bound query params)`;
}

const MAX_MESSAGE_CHARS = 2000;
const MAX_CAUSE_CHARS = 200;
const SAFE_TOKEN = /^[A-Za-z0-9_$.]{1,60}$/;
/**
 * Distinct bare-token (`CODE_PATTERN`) codes on `err`, its `.cause` chain and
 * `AggregateError.errors[]`, outermost first, at most `limit`. Same bounds as
 * `inspectDbError` (depth, 25 nodes, 25 children per node); cycle-safe; never
 * throws. Only a value matching `CODE_PATTERN` is ever returned.
 */
function collectCodes(err: unknown, limit: number): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();
  const queue: Array<{ layer: unknown; depth: number }> = [{ layer: err, depth: 0 }];
  try {
    for (let head = 0; head < queue.length && seen.size < MAX_NODES && found.length < limit; head++) {
      const { layer, depth } = queue[head];
      if (layer === null || typeof layer !== "object" || seen.has(layer)) continue;
      seen.add(layer);
      const code = (layer as { code?: unknown }).code;
      if (typeof code === "string" && CODE_PATTERN.test(code) && !found.includes(code)) {
        found.push(code);
      }
      if (depth + 1 >= MAX_CAUSE_DEPTH) continue;
      const errors = (layer as { errors?: unknown }).errors;
      const children = [
        (layer as { cause?: unknown }).cause,
        ...(Array.isArray(errors) ? errors.slice(0, MAX_CHILDREN) : []),
      ];
      for (const child of children) queue.push({ layer: child, depth: depth + 1 });
    }
  } catch {
    /* a throwing getter ends the walk with what was found so far */
  }
  return found;
}

/**
 * Operator summary of a caught error: NO stack frames, and never an arbitrary
 * serialisation of the value.
 *   - DB error, or one that hit an inspection bound (see `inspectDbError`) ->
 *     the redacted header only.
 *   - `Error` -> `name: message` (every line, URI credentials scrubbed, capped
 *     at 2000 chars) plus ` (code: X)` when the error or its `.cause` chain
 *     carries a bare-token `code` such as ENOTFOUND.
 *   - other object -> only allowlisted keys (name, code, errno, status,
 *     statusCode, type, syscall) holding short primitives, as
 *     `object {code: ENOTFOUND}`; no such key -> `[non-Error object]`.
 *   - primitive -> `String()`.
 * Scrubs URI credentials (`scheme://user:pass@`) only. Bearer tokens, API keys
 * and other secrets in plain text are NOT detected: callers must never put them
 * in an error message. Never throws. `formatFatalError` is the variant that
 * adds stack frames, for fatal handlers.
 */
export function formatErrorSummary(err: unknown): string {
  try {
    return scrubUriCredentials(renderErrorSummary(err));
  } catch {
    return "unprintable error";
  }
}

function renderErrorSummary(err: unknown): string {
  const { kind, node } = inspectDbError(err);
  if (kind) return redactedHeader(err, kind, node);
  if (err instanceof Error) {
    // Scrub BEFORE slicing so a cut can never expose half a credential, then
    // slice again in case scrubbing changed the length.
    const message = scrubUriCredentials(String(err.message)).slice(0, MAX_MESSAGE_CHARS);
    // An AggregateError reports its distinct child codes; any other Error its first code.
    const codes = collectCodes(err, err instanceof AggregateError ? 5 : 1);
    const codeText = err instanceof AggregateError ? `codes: ${codes.join(", ")}` : `code: ${codes[0]}`;
    // A network error's useful detail lives on its cause (fetch -> getaddrinfo
    // ENOTFOUND host); keep it, scrubbed and short, once classification passed.
    const cause = err.cause;
    const causeCode = (cause as { code?: unknown } | undefined)?.code;
    const causeText =
      cause instanceof Error && typeof causeCode === "string" && CODE_PATTERN.test(causeCode)
        ? `; cause: ${scrubUriCredentials(String(cause.message)).replace(/[\r\n]+/g, " ").slice(0, MAX_CAUSE_CHARS)}`
        : "";
    const suffix = codes.length > 0 ? ` (${codeText}${causeText})` : "";
    return `${safeName(err)}: ${message}${suffix}`.slice(0, MAX_MESSAGE_CHARS + 400);
  }
  if (err !== null && typeof err === "object") {
    // Values must be TOKENS or finite numbers; anything else is dropped, never
    // printed, so free text in a `code`/`name`/`type` field cannot reach a log.
    const parts: string[] = [];
    const o = err as Record<string, unknown>;
    for (const key of ["name", "type", "syscall"] as const) {
      const v = o[key];
      if (typeof v === "string" && SAFE_TOKEN.test(v)) parts.push(`${key}: ${v}`);
    }
    if (typeof o.code === "string" && CODE_PATTERN.test(o.code)) parts.push(`code: ${o.code}`);
    for (const key of ["errno", "status", "statusCode"] as const) {
      const v = o[key];
      if (typeof v === "number" && Number.isFinite(v)) parts.push(`${key}: ${v}`);
    }
    return parts.length > 0 ? `object {${parts.join(", ")}}` : "[non-Error object]";
  }
  return String(err);
}

function renderFatalError(err: unknown): string {
  const { kind, node } = inspectDbError(err);
  if (kind) {
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
    const head = redactedHeader(err, kind, node);
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
