// client-safe leaf: only imports zod + built-in URL/regex. Safe for a "use
// client" component's module graph — must never import lib/db/client,
// lib/submissions, lib/contribute, or lib/facility-write (see
// lib/leads.ts and lib/lead-fields.ts for the failure mode this avoids).
import { z } from "zod";

const PUBLIC_URL_MESSAGE =
  "Use a link to a public web page, without a username, IP address or local host name.";

// The single source of truth for the http/https URL refine — rejects
// javascript:/data: URLs at submit time, not just at facility-write time.
// lib/schema.ts's sourceSchema imports this directly (rather than keeping its
// own copy) for facility sources; the public-intake surfaces lib/contribute.ts
// (create/correction submissions) and lib/leads.ts (bare-URL tips) import this
// exact refine too, so no caller maintains its own copy.
export const httpUrlSchema = z.string().trim().max(2000).refine(hasNoControlChars, { message: PUBLIC_URL_MESSAGE, abort: true })
  .refine((v) => !hasUnstorableChars(v), { message: PUBLIC_URL_MESSAGE, abort: true }).url().refine(
  (value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return true; // `.url()` owns unparseable input; one message per failure
    }
  },
  { message: "url must use the http or https protocol" }
).refine(isPublicWebUrl, { message: PUBLIC_URL_MESSAGE });

// Why this exists: a reviewer must see where a link really goes (userinfo and
// IDN lookalikes deceive), the nightly check-sources run fetches approved
// sources from the maintainer's Mac (so IP-literal / local hosts are SSRF-ish),
// and Postgres jsonb rejects NUL. Ports stay allowed (ArcGIS uses :6443).
// Surrounding whitespace is trimmed first (a pasted URL with a trailing "\n");
// interior control chars are rejected. They are tested BEFORE `.url()`: WHATWG URL
// (and Zod's `.url()`, which hands the stripped result downstream) silently
// removes tab/CR/LF, so a later refine would never see them.
// A backslash is rejected too: WHATWG reads `\` as `/`, so `https://a.com\@b.com/`
// has host a.com while a human reviewer reads b.com.
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f\\]/;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".arpa", // covers .home.arpa
  ".localdomain",
  ".lan",
  ".corp",
  ".intranet",
  ".private",
  ".home",
];

function hasNoControlChars(value: string): boolean {
  return !CONTROL_CHARS_RE.test(value);
}

function isPublicWebUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return true; // .url() and the protocol refine report unparseable input
  }
  // The protocol refine owns non-http(s) URLs; don't pile a second message on.
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  if (url.username !== "" || url.password !== "") return false;
  // Strip ALL trailing dots: `localhost..` resolves like `localhost`.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") || IPV4_RE.test(host)) return false;
  if (!host.includes(".") || host === "localhost") return false;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  const labels = host.split(".");
  return !labels.some((label) => label === "" || label.startsWith("xn--"));
}

// Postgres jsonb rejects NUL and an unpaired UTF-16 surrogate, which would
// surface as an uncaught 500 at insert time. Rejected at the schema instead.
const UNSTORABLE_RE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;
// (no lookbehind: this module is imported by client code, and Safari <16.4
// throws a SyntaxError on it at module eval)

export function hasUnstorableChars(value: string): boolean {
  return UNSTORABLE_RE.test(value);
}

/** Drops a trailing high surrogate left behind when a slice cuts a pair in half. */
export function dropTrailingHighSurrogate(value: string): string {
  return value.replace(/[\ud800-\udbff]$/, "");
}

/** Zod refine message for `hasUnstorableChars`; pair via `storableText`. */
export const UNSTORABLE_MESSAGE = "Remove unsupported characters.";

export function storableText<T extends z.ZodType<string>>(schema: T) {
  return schema.refine((value) => !hasUnstorableChars(value), { message: UNSTORABLE_MESSAGE });
}

// sanitizeAttribution
const LEADING_AT_RE = /^@+/; // drop any leading @
const ATTRIBUTION_DISALLOWED_RE = /[^A-Za-z0-9 _.\-]/g; // conservative allowlist: alnum, space, _ . -
const WHITESPACE_RUN_RE = /\s+/g; // collapse internal whitespace

/**
 * Normalizes an optional, public contributor handle for display. Rejects
 * anything email-like, strips to a conservative handle charset, hard-caps
 * length, and returns undefined for empty/invalid input so callers omit the
 * field entirely (anonymous stays the default).
 */
export function sanitizeAttribution(raw?: string): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim().replace(LEADING_AT_RE, "");
  if (s.includes("@")) return undefined; // reject emails / anything address-like
  s = s.replace(ATTRIBUTION_DISALLOWED_RE, "");
  s = s.replace(WHITESPACE_RUN_RE, " ").trim();
  s = s.slice(0, 40); // hard cap 40
  return s.length > 0 ? s : undefined;
}
