/**
 * Shared SSRF-guard, retry/backoff, and bounded-concurrency primitives.
 *
 * Extracted verbatim from check-sources.ts (Task 1) so they can be
 * reused by the (untrusted, model-proposed) candidate-source verification
 * path without duplicating hard-won correctness logic. check-sources.ts
 * imports these back rather than redefining them; its own behavior is
 * unchanged by the extraction.
 *
 * `resolvesToBlockedAddress` (Task 2) is new here, not moved — it closes the
 * DNS-resolution gap that check-sources.ts's own `isBlockedHost` doc-comment
 * names and deliberately leaves open for its curated-URL use case. Only the
 * verification path (untrusted, model-proposed URLs) needs it.
 */
import { resolve4 as dnsResolve4, resolve6 as dnsResolve6 } from "node:dns/promises";

// --- scheme guard --------------------------------------------------------

/** Only http(s) URLs are dispatched — reject any other scheme defensively.
 * Do not assume a schema-layer restriction is live; it may be parked on
 * another branch. */
export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// --- SSRF guard: IPv4/IPv6 literal + hostname classification -------------

/** Converts a dotted-quad IPv4 string to its uint32 representation, or null if malformed. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    // Octets are parsed base-10, including leading zeros (e.g. "08" -> 8,
    // NOT treated as octal) — that leniency is intentional and safe here:
    // (i) the WHATWG URL parser canonicalizes hostnames before they reach
    // this function, so leading-zero octets don't occur on the real code
    // path, and (ii) even if one did, a leading-zero decimal octet still
    // maps to the correct, still-blocked address (e.g. "127.000.000.001"
    // parses to 127.0.0.1). Tightening this to reject leading zeros would
    // make such addresses fall through UNblocked instead.
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

/** True if `ip` (uint32) falls within the CIDR block `base/prefixLength`. */
function ipv4InCidr(ip: number, base: string, prefixLength: number): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const mask = prefixLength === 0 ? 0 : (~0 << (32 - prefixLength)) >>> 0;
  return (ip & mask) === (baseInt & mask);
}

/**
 * Private/loopback/link-local/reserved IPv4 ranges that must never be
 * probed, including the cloud metadata IP (169.254.169.254, covered by the
 * 169.254.0.0/16 link-local block).
 */
const BLOCKED_IPV4_CIDRS: Array<{ base: string; prefixLength: number }> = [
  { base: "0.0.0.0", prefixLength: 8 },
  { base: "10.0.0.0", prefixLength: 8 },
  { base: "100.64.0.0", prefixLength: 10 },
  { base: "127.0.0.0", prefixLength: 8 },
  { base: "169.254.0.0", prefixLength: 16 },
  { base: "172.16.0.0", prefixLength: 12 },
  { base: "192.0.0.0", prefixLength: 24 },
  { base: "192.168.0.0", prefixLength: 16 },
  { base: "198.18.0.0", prefixLength: 15 },
  { base: "224.0.0.0", prefixLength: 4 },
  { base: "240.0.0.0", prefixLength: 4 },
];

export function isBlockedIpv4(ip: string): boolean {
  const asInt = ipv4ToInt(ip);
  if (asInt === null) return false;
  return BLOCKED_IPV4_CIDRS.some(({ base, prefixLength }) => ipv4InCidr(asInt, base, prefixLength));
}

/**
 * True for IPv6 loopback (::1), unspecified (::), ULA (fc00::/7),
 * link-local (fe80::/10), and IPv4-mapped addresses (::ffff:a.b.c.d or
 * ::ffff:h1:h2) whose embedded v4 address is itself blocked.
 */
export function isBlockedIpv6(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "::1" || lower === "::") return true;

  // IPv4-mapped IPv6, dotted-quad form (::ffff:a.b.c.d) — extract the
  // embedded v4 and check that. Kept for any hostname passed directly
  // (not routed through new URL()'s canonicalization).
  const mappedDottedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDottedMatch) {
    return isBlockedIpv4(mappedDottedMatch[1]);
  }

  // IPv4-mapped IPv6, canonical hex-hextet form (::ffff:h1:h2) — this is
  // what Node's WHATWG URL parser actually produces, e.g.
  // new URL("http://[::ffff:169.254.169.254]/").hostname === "[::ffff:a9fe:a9fe]".
  // Reconstruct the four v4 octets from the two 16-bit hextets and reuse the
  // existing IPv4 block check.
  const mappedHexMatch = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHexMatch) {
    const h1 = parseInt(mappedHexMatch[1], 16);
    const h2 = parseInt(mappedHexMatch[2], 16);
    const octets = [(h1 >> 8) & 0xff, h1 & 0xff, (h2 >> 8) & 0xff, h2 & 0xff];
    return isBlockedIpv4(octets.join("."));
  }

  // fc00::/7 (ULA): first hextet's high 7 bits are 1111110 -> first hex
  // nibble is 0xC-0xF is too broad; the precise test is first byte 0xFC/0xFD,
  // i.e. first hextet matches fc00-fdff.
  const firstHextetMatch = lower.match(/^([0-9a-f]{1,4})::?/) ?? lower.match(/^([0-9a-f]{1,4}):/);
  if (firstHextetMatch) {
    const firstHextet = parseInt(firstHextetMatch[1], 16);
    if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true;
    // fe80::/10: first 10 bits are 1111111010 -> first hextet in fe80-febf.
    if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true;
  }

  return false;
}

/**
 * Returns true when `hostname` must NOT be probed: private/loopback/
 * link-local/reserved IPv4 or IPv6 literals (including the cloud metadata
 * IP 169.254.169.254), `localhost`, or any `*.localhost`.
 *
 * DNS resolution of ordinary hostnames to catch a public name that resolves
 * to a private IP is intentionally OUT of scope — these source URLs are
 * curated, not user-submitted. A follow-up could pin DNS if that changes.
 */
export function isBlockedHost(hostname: string): boolean {
  // `new URL(...).hostname` on a bracketed IPv6 literal (e.g. "[::1]")
  // already strips the brackets, but guard defensively in case a raw
  // bracketed value is passed directly.
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  // Canonicalize BEFORE any blocklist comparison below: lowercase, and strip
  // a single trailing root dot. "localhost." is a valid, DNS-legal spelling
  // of "localhost" (a fully-qualified name) that the literal `===` and
  // `.endsWith(".localhost")` checks below would otherwise miss — as would
  // isBlockedIpv4's dotted-quad parse for an IP literal like "127.0.0.1.".
  // Node's `dns.resolve4("localhost.")` happens to special-case it back to
  // 127.0.0.1, so `resolvesToBlockedAddress` currently catches this too —
  // but that's incidental resolver behavior this layer must not depend on to
  // stand alone.
  const lower = unbracketed.toLowerCase().replace(/\.$/, "");

  if (lower === "localhost" || lower.endsWith(".localhost")) return true;
  if (isBlockedIpv4(lower)) return true;
  if (lower.includes(":") && isBlockedIpv6(lower)) return true;

  return false;
}

// --- SSRF guard: DNS-resolution pinning (Task 2, new) ---------------------

/** Injectable DNS resolvers for {@link resolvesToBlockedAddress} — mirrors
 * the `fetchImpl`/`sleepImpl` DI pattern used elsewhere in this codebase so
 * tests never touch real DNS. */
export interface ResolveDeps {
  resolve4?: (hostname: string) => Promise<string[]>;
  resolve6?: (hostname: string) => Promise<string[]>;
}

/**
 * Resolves `hostname` via DNS and returns true if ANY resolved address (v4
 * or v6) falls in a blocked range (`BLOCKED_IPV4_CIDRS` / `isBlockedIpv6`).
 *
 * `isBlockedHost` above deliberately does not resolve DNS — its doc-comment
 * names that as out of scope because check-sources.ts's URLs are curated,
 * not user-submitted. Candidate URLs proposed by a model are neither
 * curated nor trusted, so the verification path pairs `isBlockedHost` with
 * this resolution check to close that gap.
 *
 * A resolution failure for either address family (ENOTFOUND, timeout, a
 * v4-only or v6-only host that has no records of the other family, etc.) is
 * NOT itself a blocked-address finding — connectivity failure and SSRF
 * classification are different things. The failed family is simply excluded
 * from consideration; if every family fails to resolve, this returns
 * `false` and the caller's own fetch attempt is left to fail naturally.
 *
 * The v4 and v6 results are merged into one address list, but each address
 * still gets only the check for its own family — `isBlockedIpv4` for every
 * entry, then `isBlockedIpv6` additionally when the string contains a `:`
 * (a v4 literal never does) — mirroring `isBlockedHost`'s own pattern above
 * so the two families are never cross-checked against each other's rules.
 *
 * LIMITATIONS (v1, deliberate):
 * - TOCTOU / DNS rebinding: this function resolves once, but the caller's
 *   own `fetch()` resolves DNS again, independently, moments later. The
 *   address checked here is not provably the address ultimately connected
 *   to. Real mitigation is connection-level pinning (resolve once, connect
 *   to the pinned literal, carry the original Host header) — out of scope
 *   for v1.
 * - IPv6 embedded-IPv4 coverage: `::ffff:` mapped forms (both dotted and
 *   hex-hextet), `::`, `::1`, `fc00::/7`, and `fe80::/10` ARE classified.
 *   NOT covered: IPv4-compatible (`::7f00:1`), IPv4-translated
 *   (`::ffff:0:7f00:1`), 6to4 (`2002:7f00:1::`), and NAT64
 *   (`64:ff9b::7f00:1`). Reaching those requires an attacker-controlled
 *   AAAA record, and they are largely unroutable in practice, so they are
 *   documented here rather than blocked in v1.
 */
export async function resolvesToBlockedAddress(hostname: string, deps: ResolveDeps = {}): Promise<boolean> {
  // Wrapped in single-arg arrow functions rather than assigned directly so
  // the overloaded node:dns/promises signatures (extra optional rrtype/
  // options params) don't need to structurally match ResolveDeps exactly.
  const resolve4 = deps.resolve4 ?? ((h: string) => dnsResolve4(h));
  const resolve6 = deps.resolve6 ?? ((h: string) => dnsResolve6(h));

  const [v4Result, v6Result] = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);

  const addresses: string[] = [];
  if (v4Result.status === "fulfilled") addresses.push(...v4Result.value);
  if (v6Result.status === "fulfilled") addresses.push(...v6Result.value);

  for (const address of addresses) {
    if (isBlockedIpv4(address)) return true;
    if (address.includes(":") && isBlockedIpv6(address)) return true;
  }
  return false;
}

// --- browser headers + retry/backoff --------------------------------------

/** Real-browser headers — many source hosts anti-bot-block unlabeled clients
 * with 401/403, which without a realistic User-Agent were previously
 * indistinguishable from genuine link-rot. */
export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Upper bound on how long we'll honor a Retry-After wait before falling
 * back to exponential backoff — keeps a full-dataset sweep tractable. */
export const RETRY_AFTER_CAP_MS = 15_000;

export const RETRY_BACKOFF_MS = [500, 1000];

export const defaultSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Parses a `Retry-After` header value as integer seconds. HTTP-date form is
 * not supported (falls back to exponential backoff by returning null). */
export function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds * 1000;
}

// --- bounded concurrency ---------------------------------------------------

/** Runs `worker` over `items` with at most `concurrency` in flight at once. */
export async function runWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current]);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
  return results;
}
