// @vitest-environment node
import { createRequire } from "node:module";

import type { ProxyMatcher } from "next/dist/build/analysis/get-page-static-info";
import { NextRequest } from "next/server";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { createSessionValue } from "@/lib/admin-session";

import { config, proxy } from "./proxy";

/**
 * Next compiles `config.matcher` with `getMiddlewareMatchers`, which is an
 * untyped internal (absent from `get-page-static-info.d.ts`, so it needs
 * `createRequire` rather than an import) — but it is the real build-time
 * compiler, and that is the point: the matcher is the one part of this file
 * `proxy()` cannot show you, because Next decides from it whether `proxy()` is
 * called at all. The bundled prose docs are WRONG about literal-source
 * semantics (they claim `/about` also matches `/about/team`), so these tests
 * assert against the compiler instead of against the documentation.
 *
 * If a Next upgrade moves this internal, this file fails loudly — which is the
 * correct outcome for a check whose whole value is matching the real build.
 */
const requireFromHere = createRequire(import.meta.url);
const { getMiddlewareMatchers } = requireFromHere(
  "next/dist/build/analysis/get-page-static-info",
) as {
  getMiddlewareMatchers: (
    matchers: string[],
    nextConfig: { i18n: undefined; basePath: string },
  ) => ProxyMatcher[];
};

/**
 * The cron schedule Vercel actually invokes. Read from `vercel.json` rather
 * than hardcoded so the exemption is pinned to the real path: a schedule that
 * moved, or gained a percent-escape, fails here instead of silently losing its
 * exemption and 403ing a month's mail.
 */
const { crons: CRONS } = requireFromHere("./vercel.json") as {
  crons: { path: string; schedule: string }[];
};

/** Compiles a matcher array exactly as the build does. `next.config.ts` sets
 * neither `basePath` nor `i18n`, both of which would rewrite the source. */
function compile(matchers: string[]): RegExp[] {
  return getMiddlewareMatchers(matchers, { i18n: undefined, basePath: "" }).map(
    (matcher) => new RegExp(matcher.regexp),
  );
}

function isMatched(matchers: string[], pathname: string): boolean {
  return compile(matchers).some((regexp) => regexp.test(pathname));
}

const TOKEN = "test-admin-token";
const EDGE_SECRET = "test-edge-shared-secret";
const EDGE_HEADER = "x-edge-shared-secret";
const ORIGIN = "https://www.compute-atlas.com";

type RequestOptions = {
  cookie?: string;
  edgeHeader?: string;
};

function makeRequest(pathname: string, options: RequestOptions = {}): NextRequest {
  const headers = new Headers();
  if (options.cookie !== undefined) {
    headers.set("cookie", `admin_session=${options.cookie}`);
  }
  if (options.edgeHeader !== undefined) {
    headers.set(EDGE_HEADER, options.edgeHeader);
  }
  return new NextRequest(new URL(pathname, ORIGIN), { headers });
}

/**
 * `NextResponse.next()` is a 200 carrying Next's internal continue marker and
 * no `location`. Asserting on the status + absence of a redirect (rather than
 * the internal header alone) keeps the three outcomes this file cares about —
 * continue, 307 redirect, 403 block — distinguishable without depending on a
 * private header name.
 */
function expectPassThrough(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
}

/**
 * Issues a v2 cookie as if it had been created at `issuedAtMs`, without
 * sleeping — fake-time the clock for the single call that reads it, then
 * restore real time so the proxy's own expiry check sees the real "now".
 * Same helper shape as `lib/admin-session.test.ts`.
 */
function makeCookieAt(issuedAtMs: number, token = TOKEN): string {
  vi.useFakeTimers();
  vi.setSystemTime(issuedAtMs);
  try {
    return createSessionValue(token);
  } finally {
    vi.useRealTimers();
  }
}

/** Flips the leading hex digit of the HMAC: same length, still valid hex, so
 * the comparison itself is exercised rather than a format check. */
function tamperHmac(cookie: string): string {
  const parts = cookie.split(".");
  const hmac = parts[3];
  parts[3] = (hmac[0] === "a" ? "b" : "a") + hmac.slice(1);
  return parts.join(".");
}

const ORIGINAL_ENV = {
  API_ADMIN_TOKEN: process.env.API_ADMIN_TOKEN,
  EDGE_SHARED_SECRET: process.env.EDGE_SHARED_SECRET,
  VERCEL_ENV: process.env.VERCEL_ENV,
};

function restore(key: keyof typeof ORIGINAL_ENV) {
  const original = ORIGINAL_ENV[key];
  if (original === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = original;
  }
}

beforeEach(() => {
  process.env.API_ADMIN_TOKEN = TOKEN;
  // Default posture for the admin-gate tests: no edge secret configured, so
  // the edge check fails open and cannot mask a cookie-gate assertion.
  delete process.env.EDGE_SHARED_SECRET;
  delete process.env.VERCEL_ENV;
});

afterEach(() => {
  vi.useRealTimers();
  restore("API_ADMIN_TOKEN");
  restore("EDGE_SHARED_SECRET");
  restore("VERCEL_ENV");
});

describe("proxy — admin session gate", () => {
  it("lets /admin/login through with no cookie", () => {
    expectPassThrough(proxy(makeRequest("/admin/login")));
  });

  it("redirects /admin/submissions to the login page when no cookie is present", () => {
    const response = proxy(makeRequest("/admin/submissions"));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/admin/login");
    expect(location.searchParams.get("redirect")).toBe("/admin/submissions");
  });

  it("preserves the full path in the redirect param for a nested admin route", () => {
    const response = proxy(makeRequest("/admin/facilities/edit/some-slug"));

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("redirect")).toBe("/admin/facilities/edit/some-slug");
  });

  it("redirects on a structurally invalid cookie", () => {
    const response = proxy(makeRequest("/admin/submissions", { cookie: "not-a-session" }));

    expect(response.status).toBe(307);
  });

  it("redirects on a tampered cookie (valid shape, bad HMAC)", () => {
    const tampered = tamperHmac(createSessionValue(TOKEN));

    const response = proxy(makeRequest("/admin/submissions", { cookie: tampered }));

    expect(response.status).toBe(307);
  });

  it("redirects on a cookie signed with a different token", () => {
    const foreign = createSessionValue("some-other-token");

    const response = proxy(makeRequest("/admin/submissions", { cookie: foreign }));

    expect(response.status).toBe(307);
  });

  it("redirects on an expired cookie (older than the 7-day server-side lifetime)", () => {
    const day = 24 * 60 * 60 * 1000;

    const expired = proxy(
      makeRequest("/admin/submissions", { cookie: makeCookieAt(Date.now() - 8 * day) }),
    );
    expect(expired.status).toBe(307);

    // Differential control: the only difference is the cookie's age, so this
    // pins the redirect above to the expiry check rather than to the
    // fake-timer issuance itself (whose HMAC is valid either way). The
    // expiry constant lives in `lib/admin-session.ts` and is mutation-tested
    // there; this asserts the proxy actually honours it.
    expectPassThrough(
      proxy(makeRequest("/admin/submissions", { cookie: makeCookieAt(Date.now() - 6 * day) })),
    );
  });

  it("lets a valid cookie through", () => {
    const response = proxy(
      makeRequest("/admin/submissions", { cookie: createSessionValue(TOKEN) }),
    );

    expectPassThrough(response);
  });

  it("protects /admin/contact, which renders contributor names and emails", () => {
    expect(proxy(makeRequest("/admin/contact")).status).toBe(307);
    expectPassThrough(proxy(makeRequest("/admin/contact", { cookie: createSessionValue(TOKEN) })));
  });

  it("fails closed when API_ADMIN_TOKEN is unset", () => {
    const cookie = createSessionValue(TOKEN);
    delete process.env.API_ADMIN_TOKEN;

    expect(proxy(makeRequest("/admin/submissions", { cookie })).status).toBe(307);
  });
});

describe("proxy — edge shared-secret gate", () => {
  beforeEach(() => {
    process.env.VERCEL_ENV = "production";
    process.env.EDGE_SHARED_SECRET = EDGE_SECRET;
  });

  it("blocks an /api request with no edge header", () => {
    const response = proxy(makeRequest("/api/facilities"));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("sends BOTH no-store header names on the 403", () => {
    // Mostly moot: reaching a 403 means the request skipped Cloudflare, so CF is
    // not in the path to store it. The case that matters is an activation or
    // secret-rotation mismatch, when CF *is* in the path and every request 403s
    // — a 403 stored at the edge then outlives the fix that resolved it. Both
    // names because Cloudflare consults `CDN-Cache-Control` first.
    const response = proxy(makeRequest("/api/facilities"));

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("cdn-cache-control")).toBe("no-store");
  });

  it("blocks an /api request with the wrong edge header value", () => {
    const response = proxy(makeRequest("/api/facilities", { edgeHeader: "wrong-secret" }));

    expect(response.status).toBe(403);
  });

  it("blocks an /api request with an empty edge header value", () => {
    const response = proxy(makeRequest("/api/facilities", { edgeHeader: "" }));

    expect(response.status).toBe(403);
  });

  it("allows an /api request carrying the correct edge header", () => {
    expectPassThrough(proxy(makeRequest("/api/facilities", { edgeHeader: EDGE_SECRET })));
  });

  // The bandwidth-heavy pages (/map, /table, /data) are deliberately NOT in
  // the matcher yet — step 5 of the activation sequence in proxy.ts — so there
  // is nothing to assert about them here: `proxy()` is never called for them.
  // Their absence is pinned in the "matcher scope" block below instead, which
  // is the only place a unit test can see the matcher at all.

  it("blocks /admin before the cookie gate runs, even with a valid session", () => {
    const response = proxy(
      makeRequest("/admin/submissions", { cookie: createSessionValue(TOKEN) }),
    );

    expect(response.status).toBe(403);
  });

  it("still applies the cookie gate when the edge header is correct", () => {
    expect(proxy(makeRequest("/admin/submissions", { edgeHeader: EDGE_SECRET })).status).toBe(307);
    expectPassThrough(
      proxy(
        makeRequest("/admin/submissions", {
          edgeHeader: EDGE_SECRET,
          cookie: createSessionValue(TOKEN),
        }),
      ),
    );
  });

  it("lets /api/cron/* through without the header — Vercel Cron never traverses Cloudflare", () => {
    expectPassThrough(proxy(makeRequest("/api/cron/state-digest")));
  });

  it("lets /api/cron/* through with a wrong header too (the exemption is unconditional)", () => {
    expectPassThrough(proxy(makeRequest("/api/cron/state-digest", { edgeHeader: "wrong" })));
  });

  it("does not exempt a path that merely starts with the cron prefix string", () => {
    expect(proxy(makeRequest("/api/cronjobs")).status).toBe(403);
  });

  it("does not exempt a percent-encoded path that keeps the cron prefix", () => {
    // URL parsing does NOT decode percent-escapes (it does normalize
    // dot-segments — the assertion below), so these arrive at the proxy with the
    // `/api/cron/` prefix intact while naming something else. Next will not route
    // them anywhere, so nothing was exploitable — but this is the gate's one
    // UNCONDITIONAL exemption, and its safety should not rest on Next's routing.
    for (const pathname of [
      "/api/cron/..%2ffacilities",
      "/api/cron/..%2Ffacilities",
      "/api/cron/%73tate-digest",
      "/api/cron%2fstate-digest",
    ]) {
      expect(new URL(pathname, ORIGIN).pathname).toContain("%");
      expect(proxy(makeRequest(pathname)).status).toBe(403);
    }
  });

  it("still exempts the cron path vercel.json actually schedules", () => {
    // Differential control for the refusal above: it must not cost the real
    // invocation its exemption. Vercel Cron can reach the deployment without
    // traversing Cloudflare, so it never carries the edge header; breaking this
    // silently skips a month's mail (first scheduled run 2026-10-01).
    expect(CRONS.length).toBeGreaterThan(0);
    for (const { path } of CRONS) {
      expectPassThrough(proxy(makeRequest(path)));
    }
  });

  it("sees dot-segments already normalized away, before the exemption is checked", () => {
    // `/api/cron/../facilities` reaches `proxy()` as `/api/facilities` — done by
    // URL parsing, not by this file and not by Cloudflare's normalization
    // ruleset, which this file deliberately does not depend on.
    expect(new URL("/api/cron/../facilities", ORIGIN).pathname).toBe("/api/facilities");
    expect(proxy(makeRequest("/api/cron/../facilities")).status).toBe(403);
  });
});

describe("proxy — edge gate rollout posture", () => {
  it("FAILS OPEN when EDGE_SHARED_SECRET is unset, even in production", () => {
    process.env.VERCEL_ENV = "production";
    delete process.env.EDGE_SHARED_SECRET;

    expectPassThrough(proxy(makeRequest("/api/facilities")));
    expectPassThrough(proxy(makeRequest("/api/search")));
  });

  it("FAILS OPEN when EDGE_SHARED_SECRET is set but empty", () => {
    process.env.VERCEL_ENV = "production";
    process.env.EDGE_SHARED_SECRET = "";

    expectPassThrough(proxy(makeRequest("/api/facilities")));
  });

  it("does not enforce on preview deployments, which never traverse Cloudflare", () => {
    process.env.VERCEL_ENV = "preview";
    process.env.EDGE_SHARED_SECRET = EDGE_SECRET;

    expectPassThrough(proxy(makeRequest("/api/facilities")));
  });

  it("does not enforce when VERCEL_ENV is unset (local next dev / next start)", () => {
    delete process.env.VERCEL_ENV;
    process.env.EDGE_SHARED_SECRET = EDGE_SECRET;

    expectPassThrough(proxy(makeRequest("/api/facilities")));
  });

  it("does not widen the matcher ahead of enforcement (activation step 5)", () => {
    // Matching the bandwidth-heavy pages costs a proxy invocation on the
    // site's busiest routes (proxy is step 3 of Next's execution order, ahead
    // of the filesystem/dynamic route steps, so it runs before any cache
    // lookup). While the check fails open that buys no protection, so the
    // widening is deferred to ACTIVATION step 5 — a different numbering from
    // Next's execution order above — which falls after enforcement begins at
    // activation step 3, the redeploy, rather than being shipped with it.
    for (const pathname of ["/map", "/table", "/data"]) {
      expect(isMatched(config.matcher, pathname)).toBe(false);
    }
  });

  it("leaves the admin cookie gate working while the edge gate is failing open", () => {
    process.env.VERCEL_ENV = "production";
    delete process.env.EDGE_SHARED_SECRET;

    expect(proxy(makeRequest("/admin/submissions")).status).toBe(307);
    expectPassThrough(
      proxy(makeRequest("/admin/submissions", { cookie: createSessionValue(TOKEN) })),
    );
  });
});

describe("proxy — matcher scope, compiled by the installed Next", () => {
  it("is exactly the admin and API prefixes", () => {
    expect(config.matcher).toEqual(["/admin/:path*", "/api/:path*"]);
  });

  it("covers every admin route, including the ones rendering contributor PII", () => {
    // `/admin/contact` renders submitter names, email addresses and message
    // bodies, and every `app/admin/**` page delegates authentication entirely
    // to this file. A matcher typo here is a data exposure with no other gate
    // behind it, which is what this assertion exists to catch.
    for (const pathname of [
      "/admin",
      "/admin/",
      "/admin/login",
      "/admin/contact",
      "/admin/submissions",
      "/admin/facilities/edit/some-slug",
    ]) {
      expect(isMatched(config.matcher, pathname)).toBe(true);
    }
  });

  it("covers the API surface, cron included (the exemption is in the body, not the matcher)", () => {
    for (const pathname of ["/api", "/api/facilities", "/api/contribute", "/api/cron/state-digest"]) {
      expect(isMatched(config.matcher, pathname)).toBe(true);
    }
  });

  it("leaves CDN-served assets and ordinary pages out", () => {
    for (const pathname of [
      "/",
      "/facilities/some-slug",
      "/explore/states/tx",
      "/data/facilities.geojson",
      "/basemap/style.json",
      "/fonts/inter.woff2",
      "/_next/static/chunks/main.js",
      "/_next/image",
    ]) {
      expect(isMatched(config.matcher, pathname)).toBe(false);
    }
  });

  it("compiles a literal source to an EXACT match, contradicting the bundled docs", () => {
    // Next's bundled `proxy.md` says sources are "anchored to the start of the
    // path: `/about` matches `/about` and `/about/team`". Against the real
    // compiler a literal is exact. This is the precondition activation step 5
    // relies on: adding `/data` must not also put the proxy in front of every
    // `public/data/*.geojson` tile request. Not the live config — this pins the
    // semantics of the entry that will be added.
    expect(isMatched(["/data"], "/data")).toBe(true);
    expect(isMatched(["/data"], "/data/facilities.geojson")).toBe(false);
    expect(isMatched(["/data"], "/data/siting-context.json")).toBe(false);
  });

  it("compiles a `:path*` source to cover the bare prefix and any depth below it", () => {
    expect(isMatched(["/admin/:path*"], "/admin")).toBe(true);
    expect(isMatched(["/admin/:path*"], "/admin/a/b/c")).toBe(true);
    expect(isMatched(["/admin/:path*"], "/administrators")).toBe(false);
  });
});
