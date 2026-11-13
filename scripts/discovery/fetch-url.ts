// GET-only URL fetcher behind fetch-url.sh for the unattended discovery
// `claude -p` session. Every hop (first URL and each redirect target, cap 10)
// is vetted before any connection: http(s) only, a raw-authority check (WHATWG
// folds fullwidth/%-encoded hosts before IDNA, so url.hostname alone lies), a
// blocked-host check, and a DNS check that no address is private, loopback,
// link-local, metadata, CGNAT, unique-local or IPv4-mapped. The connection
// itself goes through pinnedFetch, whose lookup hands the socket only the
// vetted address, so there is no rebinding gap.
//
// There is deliberately NO environment or CLI seam that relaxes the guard:
// tests inject `fetchImpl`/`resolve*` through runFetch's `deps` argument only,
// which the CLI entry never populates.
//
// Exit codes: 0 body written (any HTTP status, like curl without -f);
// 1 network/limit failure; 2 refused by the guard or bad arguments.

import { pathToFileURL } from "node:url";

import { isBlockedHost, isHttpUrl, pinnedFetch, resolvesToBlockedAddress, type ResolveDeps } from "./net-guard";

export const MAX_REDIRECTS = 10;
export const MAX_TIME_MS = 60_000;
export const MAX_BYTES = 52_428_800;
export const USER_AGENT = "ComputeAtlas-discovery/1.0 (+https://www.compute-atlas.com)";

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const NON_ASCII_RE = /[^\u0000-\u007f]/;

export class RefusedError extends Error {}

export interface FetchDeps extends ResolveDeps {
  fetchImpl?: typeof fetch;
  write?: (chunk: Uint8Array) => void | Promise<void>;
  timeoutMs?: number;
}

/** Authority of the RAW string (never url.hostname): `@`, `%` and non-ASCII
 * are refused because WHATWG folds them before the host is checked. */
function rawAuthorityProblem(raw: string): string | null {
  const authority = raw.replace(SCHEME_RE, "").split(/[/?#\\]/, 1)[0];
  if (authority.includes("@")) return "userinfo in URL";
  if (authority.includes("%")) return "percent-encoded authority";
  if (NON_ASCII_RE.test(authority)) return "non-ASCII authority";
  return null;
}

/** Throws RefusedError unless `raw` is safe to connect to right now. */
export async function vetUrl(raw: string, deps: ResolveDeps = {}): Promise<URL> {
  if (!isHttpUrl(raw)) throw new RefusedError("only http(s) URLs are allowed");
  const problem = rawAuthorityProblem(raw);
  if (problem) throw new RefusedError(problem);
  const url = new URL(raw);
  if (url.username !== "" || url.password !== "") throw new RefusedError("userinfo in URL");
  if (isBlockedHost(url.hostname)) throw new RefusedError(`blocked host ${url.hostname}`);
  if (await resolvesToBlockedAddress(url.hostname, deps)) throw new RefusedError(`${url.hostname} resolves to a blocked address`);
  return url;
}

/** Resolves a Location header; an authority-bearing one is vetted raw. */
function nextHop(location: string, current: URL): string {
  const loc = location.trim();
  const authorityBearing = SCHEME_RE.test(loc) || /^[/\\]{2}/.test(loc);
  if (authorityBearing) {
    const problem = rawAuthorityProblem(loc.replace(/^[/\\]{2}/, `${current.protocol}//`));
    if (problem) throw new RefusedError(`redirect refused: ${problem}`);
  }
  return new URL(loc, current).href;
}

// undici sends Accept-Encoding and decodes bodies, unlike the old curl (no
// --compressed), so compressed pages now arrive decoded. MAX_BYTES counts the
// DECODED bytes read here, which is what bounds a decompression bomb.
export async function runFetch(rawUrl: string, deps: FetchDeps = {}): Promise<void> {
  const doFetch = deps.fetchImpl ?? pinnedFetch;
  const write = deps.write ?? ((chunk: Uint8Array) => new Promise<void>((resolve, reject) => process.stdout.write(chunk, (e) => (e ? reject(e) : resolve()))));
  const signal = AbortSignal.timeout(deps.timeoutMs ?? MAX_TIME_MS);
  let target = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await vetUrl(target, deps);
    const res = await doFetch(url.href, { redirect: "manual", signal, headers: { "user-agent": USER_AGENT } });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      target = nextHop(location, url);
      continue;
    }
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (total + value.byteLength > MAX_BYTES) {
          await write(value.subarray(0, MAX_BYTES - total));
          await reader.cancel();
          throw new Error("response exceeds size limit");
        }
        total += value.byteLength;
        await write(value);
      }
    }
    return;
  }
  throw new Error("too many redirects");
}

export async function main(argv: string[], deps: FetchDeps = {}): Promise<number> {
  if (argv.length !== 1) {
    console.error("fetch-url: exactly one URL argument");
    return 2;
  }
  try {
    await runFetch(argv[0], deps);
    return 0;
  } catch (err) {
    if (err instanceof RefusedError) {
      // lint-no-raw-error-logs: allow -- network/refusal errors only; imports no DB code (node:url, net-guard: node:dns + undici)
      console.error(`fetch-url: refused: ${err.message}`);
      return 2;
    }
    // lint-no-raw-error-logs: allow -- network/refusal errors only; imports no DB code (node:url, net-guard: node:dns + undici)
    console.error(`fetch-url: ${err instanceof Error ? err.message : "request failed"}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
