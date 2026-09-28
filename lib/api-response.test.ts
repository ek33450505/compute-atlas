import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import {
  cacheableJson,
  corsPreflight,
  jsonResponse,
  API_VERSION,
  CORS_HEADERS_BY_SCOPE,
  CORS_RESPONSE_HEADERS,
  NO_STORE_HEADERS,
  READ_CACHE,
  type CorsScope,
} from "@/lib/api-response";

/**
 * Source roots that can plausibly build a `Response`. `proxy.ts` sits at the
 * repo root, so it is listed separately.
 */
const SOURCE_ROOTS = ["app", "lib", "components"];
const ROOT_FILES = ["proxy.ts"];

/**
 * The header name used as an object KEY — i.e. a definition of the pair, not a
 * `headers.get("CDN-Cache-Control")` read. Case-insensitive and both quote
 * styles, so a fork cannot hide behind formatting.
 */
const CDN_HEADER_DEFINITION = /["']cdn-cache-control["']\s*:/i;

/** Every non-test `.ts`/`.tsx` under the source roots, repo-relative. */
function sourceFiles(): string[] {
  const files = [...ROOT_FILES];
  for (const root of SOURCE_ROOTS) {
    const entries = readdirSync(join(process.cwd(), root), {
      recursive: true,
      encoding: "utf8",
    });
    for (const entry of entries) {
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      files.push(join(root, entry));
    }
  }
  return files;
}

/**
 * Every `app/api/**\/route.ts` whose `OPTIONS` re-exports `corsPreflight`, mapped
 * to the scope literal it passes.
 *
 * This is the **second** layer, and it is the one the type system cannot
 * provide. `corsPreflight`'s `scope` is a required parameter with no default, so
 * an *absent* scope is a compile error — but a *wrong* scope compiles perfectly,
 * and a wrong scope is the whole 2026-09-27 finding. So the map is not
 * redundant with `tsc`; the two catch disjoint mistakes.
 *
 * No entry may be `null`, and that is now a type-level fact rather than a
 * convention: five routes were recorded as `null` while a transitional `admin`
 * default existed and their files were off-limits to the split. All five were
 * converted in the follow-up unit — four anonymous-intake POSTs to
 * `public-write`, and `app/api/submissions` to `admin`, which *equalled* the
 * default and so changed nothing at runtime. That one is the case proving this
 * map reads the source literal rather than the effective header: it went RED on
 * conversion exactly like the other four, because what is pinned is the stated
 * posture, not the resulting bytes.
 *
 * Assert-both-directions is the point: a new route that forgets a scope shows up
 * as an unexpected key, and changing a route's scope without updating this map
 * is also RED, so the list cannot go quietly stale.
 */
const EXPECTED_ROUTE_SCOPES: Record<string, CorsScope> = {
  "app/api/access/request/route.ts": "public-write",
  "app/api/contact/route.ts": "public-write",
  "app/api/contribute/route.ts": "public-write",
  "app/api/facilities/[id]/route.ts": "admin", // mixed: public GET + bearer PATCH/DELETE
  "app/api/facilities/route.ts": "admin", // mixed: public GET + bearer POST
  "app/api/leads/route.ts": "public-write",
  "app/api/revalidate/route.ts": "admin",
  "app/api/schema/route.ts": "read",
  "app/api/search/route.ts": "read",
  "app/api/stats/route.ts": "read",
  "app/api/submissions/[id]/approve/route.ts": "admin",
  "app/api/submissions/[id]/reject/route.ts": "admin",
  "app/api/submissions/route.ts": "admin", // bearer GET (admin) + bearer POST (admin|intake)
  "app/api/subscribe/route.ts": "public-write",
  "app/api/subscribe/unsubscribe/route.ts": "public-write",
};

/**
 * A `return corsPreflight(...)` **call**, capturing the scope literal if given.
 * Matching the `return` (not the bare identifier) is what keeps
 * `app/api/csp-report/route.ts` out of the scan — it names `corsPreflight` only
 * in a comment explaining why it deliberately serves no CORS headers at all.
 */
const PREFLIGHT_CALL = /return corsPreflight\(\s*(?:"([a-z-]+)")?\s*\)/;

/**
 * A route that reads a bearer credential — the two `lib/api-auth.ts` gates.
 *
 * This is the one fact the `admin` scope is genuinely keyed on. The scopes are
 * posture-keyed by design, so the question a preflight answers is "may a caller
 * send `Authorization` to this path", and that is answerable from the route's
 * own source rather than from a hand-maintained list.
 */
const BEARER_GATE = /require(?:Admin|Intake)\(/;

/** Repo-relative `app/api/**\/route.ts` paths, sorted. */
function apiRouteFiles(): string[] {
  return readdirSync(join(process.cwd(), "app", "api"), {
    recursive: true,
    encoding: "utf8",
  })
    .filter((entry) => /(^|\/)route\.ts$/.test(entry))
    .map((entry) => join("app", "api", entry))
    .sort();
}

describe("CORS scopes", () => {
  it("narrows the read scope to GET and drops Authorization", () => {
    // The 2026-09-27 finding: `GET /api/facilities` advertised all four write
    // verbs plus `Authorization` to every origin, including `https://evil.example`.
    expect(CORS_HEADERS_BY_SCOPE.read).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
  });

  it("advertises POST but not Authorization on the anonymous-write scope", () => {
    // These paths (moderated intake, subscribe) take POST from any origin by
    // design, so POST must stay — but nothing there reads a bearer token, and
    // none of them export PATCH or DELETE.
    expect(CORS_HEADERS_BY_SCOPE["public-write"]).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
  });

  it("keeps the pre-split breadth on the admin scope", () => {
    expect(CORS_HEADERS_BY_SCOPE.admin).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
  });

  it("names Authorization in exactly one scope, and no write verb outside it", () => {
    // The equality assertions above would still pass if a fourth scope were
    // added that re-widened the surface; this one bites on any such addition.
    const withAuth = Object.entries(CORS_HEADERS_BY_SCOPE)
      .filter(([, headers]) => headers["Access-Control-Allow-Headers"].includes("Authorization"))
      .map(([scope]) => scope);
    const withDestructiveVerb = Object.entries(CORS_HEADERS_BY_SCOPE)
      .filter(([, headers]) => /PATCH|DELETE|PUT/.test(headers["Access-Control-Allow-Methods"]))
      .map(([scope]) => scope);

    expect(withAuth).toEqual(["admin"]);
    expect(withDestructiveVerb).toEqual(["admin"]);
  });

  it("sets a literal `*` origin and therefore no Vary: Origin", () => {
    // `Vary` names request headers the response CONTENT depends on. A constant
    // `*` depends on nothing, so declaring `Vary: Origin` would be false, and on
    // a shared cache honouring it would hand any caller a cache-fragmentation
    // lever against s-maxage windows up to 604800.
    //
    // This is the guard for the day that stops being true: if
    // `Access-Control-Allow-Origin` is ever derived from the request (reflected
    // origin or allowlist), this test fails and `Vary: Origin` becomes
    // mandatory — a shared cache would otherwise serve one origin's grant to
    // another.
    const everySet = { ...CORS_HEADERS_BY_SCOPE, response: CORS_RESPONSE_HEADERS };

    for (const [name, headers] of Object.entries(everySet)) {
      expect(headers["Access-Control-Allow-Origin"], name).toBe("*");
      expect(headers, name).not.toHaveProperty("Vary");
    }
  });

  it("carries nothing but the origin on an actual response", () => {
    // The preflight-only pair is absent by construction, not by narrowing: a
    // `read`-scoped response would still publish a verb claim, and on
    // `/api/submissions` (bearer GET + POST) that claim would be false.
    expect(CORS_RESPONSE_HEADERS).toEqual({ "Access-Control-Allow-Origin": "*" });
  });

  it("never sets Access-Control-Allow-Credentials alongside the `*` origin", () => {
    // `*` plus credentials is rejected by browsers, but a future edit adding it
    // would be the one change that turns this permissive origin into a real
    // ambient-credential hole. Pin its absence rather than trust the comment.
    const everySet = { ...CORS_HEADERS_BY_SCOPE, response: CORS_RESPONSE_HEADERS };

    for (const [name, headers] of Object.entries(everySet)) {
      expect(headers, name).not.toHaveProperty("Access-Control-Allow-Credentials");
    }
  });
});

describe("corsPreflight", () => {
  it("returns a 204 with the requested scope's headers, for every scope", () => {
    for (const scope of Object.keys(CORS_HEADERS_BY_SCOPE) as CorsScope[]) {
      const res = corsPreflight(scope);

      expect(res.status, scope).toBe(204);
      for (const [name, value] of Object.entries(CORS_HEADERS_BY_SCOPE[scope])) {
        expect(res.headers.get(name), `${scope}/${name}`).toBe(value);
      }
    }
  });

  it("does not advertise Authorization on a read preflight", () => {
    const res = corsPreflight("read");

    expect(res.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).not.toContain("Authorization");
    expect(res.headers.get("access-control-allow-methods")).not.toMatch(/POST|PATCH|DELETE/);
  });

  it("does not advertise Authorization on an anonymous-write preflight", () => {
    const res = corsPreflight("public-write");

    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).not.toContain("Authorization");
    expect(res.headers.get("access-control-allow-methods")).not.toMatch(/PATCH|DELETE/);
  });

  it("keeps Authorization and the write verbs on an admin preflight", () => {
    const res = corsPreflight("admin");

    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(res.headers.get("access-control-allow-methods")).toBe(
      "GET, POST, PATCH, DELETE, OPTIONS"
    );
  });

  it("takes the scope as a required argument, so a forgotten scope cannot compile", () => {
    // Replaces an earlier test that pinned a transitional `admin` DEFAULT. The
    // default is gone deliberately: every possible default is wrong in one
    // direction and silent in both — `admin` over-advertises a read endpoint
    // (the 2026-09-27 finding itself), `read` blocks a real cross-origin JSON
    // POST at the preflight — so requiring the argument is the only version that
    // cannot be got wrong by omission.
    //
    // `Function.prototype.length` counts parameters before the first one with a
    // default, so it is 1 here and would drop to 0 the moment `= "admin"` came
    // back. That matters because re-adding a default breaks NO other test in
    // this file: every call site already passes a literal, so all of them keep
    // passing and the safety property would vanish silently. This is the only
    // assertion that fails on it.
    //
    // Honest limit: this catches a restored default VALUE, not `scope?:
    // CorsScope`, which emits identical JS and leaves `length` at 1. That
    // variant is covered by the source scan below — it would let a bare
    // `corsPreflight()` compile, and the scan asserts none exists.
    expect(corsPreflight.length).toBe(1);
  });

  it("gives every API route the scope its path actually accepts", () => {
    const actual: Record<string, CorsScope | null> = {};
    for (const file of apiRouteFiles()) {
      const match = PREFLIGHT_CALL.exec(readFileSync(join(process.cwd(), file), "utf8"));
      if (!match) continue;
      actual[file] = (match[1] as CorsScope | undefined) ?? null;
    }

    expect(actual).toEqual(EXPECTED_ROUTE_SCOPES);
  });

  it("scopes a mixed path to the union of what it accepts, not to `read`", () => {
    // `/api/facilities` and `/api/facilities/[id]` each pair a public GET with a
    // bearer-gated write, and one OPTIONS answers for the whole path. Narrowing
    // them would be the plausible-looking change that breaks a real caller, so
    // it is pinned separately from the map above — a reviewer reading only that
    // map could mistake these two `admin` entries for stragglers.
    for (const file of ["app/api/facilities/route.ts", "app/api/facilities/[id]/route.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");

      expect(PREFLIGHT_CALL.exec(source)?.[1], file).toBe("admin");
      // ...and the mixedness is a fact about the file, not a claim in this test:
      // if the write handler is ever removed, this fails and `read` becomes correct.
      expect(source, file).toMatch(/^export async function (POST|PATCH|DELETE)/m);
    }
  });

  it("has no route calling corsPreflight without a scope", () => {
    // Derived from the source tree, NOT from `EXPECTED_ROUTE_SCOPES` — asserting
    // that map contains no `null` would only be asserting on this file's own
    // fixture.
    //
    // A bare call is a compile error now that `scope` is required, so on a tree
    // that typechecks this should be unfailable. It is kept anyway because it
    // covers the one way that stops being true without `Function.length`
    // noticing: relaxing the signature to `scope?: CorsScope` emits identical JS
    // and would quietly re-permit every bare call. `tsc` and this scan are run
    // by separate gates, so neither substitutes for the other.
    const bare = apiRouteFiles().filter((file) => {
      const match = PREFLIGHT_CALL.exec(readFileSync(join(process.cwd(), file), "utf8"));
      return match !== null && match[1] === undefined;
    });

    expect(bare).toEqual([]);
  });

  it("advertises Authorization exactly where the route reads a bearer token", () => {
    // A cross-check between two facts about each file that are not derived from
    // each other: whether it calls a `lib/api-auth.ts` gate, and which scope its
    // OPTIONS names. So it bites on a route that gains a bearer gate while
    // keeping an anonymous scope — a preflight that would 405 the new client —
    // and on the reverse, an anonymous surface quietly promoted to `admin`.
    //
    // ⚠️ Both facts are read from the ROUTE FILE, and the scope deliberately is
    // NOT taken from `EXPECTED_ROUTE_SCOPES`. Reading it from the map made this
    // test blind to exactly the drift it exists to catch: a mutation giving
    // `/api/contribute` the `admin` scope left this assertion green, because the
    // map still said `public-write` and the map was what it compared against. It
    // only ever restated a conclusion the map-equality test had already reached.
    //
    // Only the `Authorization` bit is cross-checked, deliberately never the verb
    // list. The scopes are posture-keyed precisely so they need not mirror each
    // route's `export function` table (`/api/facilities` is `admin` and exports
    // no PATCH/DELETE), and re-deriving that list here would rebuild the second
    // copy the design exists to avoid.
    const mismatched: string[] = [];

    for (const file of Object.keys(EXPECTED_ROUTE_SCOPES)) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      const gated = BEARER_GATE.test(source);
      const scope = PREFLIGHT_CALL.exec(source)?.[1] as CorsScope | undefined;
      // A missing literal is itself the mismatch — reported rather than passed on
      // to `corsPreflight`, whose `scope` is required and would otherwise have to
      // be coerced back into the very default this design removed.
      if (scope === undefined) {
        mismatched.push(`${file}: no scope literal`);
        continue;
      }
      const advertisesAuth = (
        corsPreflight(scope).headers.get("access-control-allow-headers") ?? ""
      ).includes("Authorization");

      if (gated !== advertisesAuth) {
        mismatched.push(`${file}: bearer gate ${gated}, advertises Authorization ${advertisesAuth}`);
      }
    }

    expect(mismatched).toEqual([]);
  });

  it("gives every anonymous-write route POST with neither Authorization nor a destructive verb", () => {
    // The concrete change of the 2026-09-27 follow-up unit: `/api/contribute`,
    // `/api/leads`, `/api/contact` and `/api/access/request` each answered every
    // origin with `Authorization` plus `PATCH, DELETE` before it, on paths whose
    // only handler is an anonymous POST. The scope is re-read from each file
    // rather than taken from the map above, so this asserts the headers a
    // browser is actually handed, not the literal the map already pins.
    const anonymousWrite = Object.keys(EXPECTED_ROUTE_SCOPES).filter(
      (file) => EXPECTED_ROUTE_SCOPES[file] === "public-write"
    );
    // Guard against the loop below passing vacuously on an empty list.
    expect(anonymousWrite.length).toBeGreaterThanOrEqual(6);

    for (const file of anonymousWrite) {
      const scope = PREFLIGHT_CALL.exec(readFileSync(join(process.cwd(), file), "utf8"))?.[1];
      // Asserted, not defaulted: `scope` is required, and quietly substituting a
      // fallback here would test a value no route actually passes.
      expect(scope, file).toBeDefined();
      const res = corsPreflight(scope as CorsScope);

      expect(res.headers.get("access-control-allow-methods"), file).toContain("POST");
      expect(res.headers.get("access-control-allow-methods"), file).not.toMatch(/PATCH|DELETE/);
      expect(res.headers.get("access-control-allow-headers"), file).not.toContain("Authorization");
    }
  });
});

describe("NO_STORE_HEADERS", () => {
  it("is the `no-store` pair, under both header names", () => {
    expect(NO_STORE_HEADERS).toEqual({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store",
    });
  });

  it("is what jsonResponse actually emits, not a parallel copy of it", () => {
    // The literal values are pinned by the `jsonResponse` block below; this
    // pins that the helper reads THIS constant, so the two cannot drift.
    const res = jsonResponse({ ok: true });

    for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
      expect(res.headers.get(name)).toBe(value);
    }
  });

  it("is defined in exactly one place in the source tree", () => {
    // Three private copies existed before 2026-09-27 — the two subscribe token
    // routes and `/api/access/confirm`, each carrying its own comment saying it
    // was worth hoisting. Three is also the count that diverged the last time
    // this project forked a response helper, so this is a test rather than a
    // convention. It scans source because a value assertion cannot see a fork:
    // a divergent private copy passes every behavioural test in the repo right
    // up until one of the two names is dropped from it. Test files are excluded
    // — they legitimately name the header when asserting on a response.
    const definers = sourceFiles()
      .filter((file) => CDN_HEADER_DEFINITION.test(readFileSync(join(process.cwd(), file), "utf8")))
      .sort();

    expect(definers).toEqual(["lib/api-response.ts"]);
  });
});

describe("jsonResponse", () => {
  it("is no-store by default, on both Cache-Control and CDN-Cache-Control", () => {
    // `GET /api/submissions` is bearer-gated and returns every staged row
    // through this helper. Without an explicit directive, Next's dynamic-route
    // default (`public, max-age=0, must-revalidate`) applies, and Cloudflare
    // reads `public`/`must-revalidate` as a waiver of RFC 9111 §3.5 — so an
    // authenticated body became edge-storable. Cloudflare consults
    // `CDN-Cache-Control` first, hence both names.
    const res = jsonResponse({ count: 1, submissions: [{ id: "s-1" }] });

    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
  });

  it("emits no-store on an error body too, not just a 200", () => {
    const res = jsonResponse({ error: "Unauthorized" }, { status: 401 });

    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
  });

  it("keeps the no-store default when the caller supplies an unrelated header", () => {
    // Distinct from the override tests below: a caller setting *some other*
    // header (a 429's `Retry-After`) must not lose the cache default. Guards
    // against "apply the default only when `init.headers` is absent", which
    // would silently un-protect every call site that sets any header at all.
    const res = jsonResponse(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": "60" } }
    );

    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("CDN-Cache-Control")).toBe("no-store");
  });

  it("lets an explicit caller-supplied Cache-Control override the default", () => {
    // The defaults must sit BEFORE the `init.headers` spread. `app/api/search`
    // relies on this to pin its degraded-result response to `no-store`, and any
    // future caller needing a real directive must be able to set one.
    const res = jsonResponse(
      { ok: true },
      { headers: { "Cache-Control": "public, s-maxage=60" } }
    );

    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=60");
  });

  it("lets an explicit caller-supplied CDN-Cache-Control override the default", () => {
    const res = jsonResponse(
      { ok: true },
      { headers: { "CDN-Cache-Control": "public, s-maxage=60" } }
    );

    expect(res.headers.get("CDN-Cache-Control")).toBe("public, s-maxage=60");
  });

  it("publishes the origin alone, with no preflight-only verb claim", () => {
    // `Access-Control-Allow-Methods`/`-Allow-Headers` are read during a
    // preflight and nowhere else, so on a response body they permit nothing and
    // forbid nothing — they only publish a claim. This helper serves a
    // bearer-gated read, a write result, a 400 and a 429, so no one claim could
    // be true of all of them. Publishing none is the honest option, and it is
    // what stops an error body from advertising `Authorization` to any origin.
    const res = jsonResponse({ ok: true });

    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
  });

  it("makes no verb claim on an error body either", () => {
    // The 400/401/429 path is what a prober actually reaches on a read endpoint
    // — `/api/search?bad=1` — so it is asserted separately from the 200 above.
    const res = jsonResponse({ error: "Unauthorized" }, { status: 401 });

    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
  });
});

describe("cacheableJson", () => {
  it("sets a public Cache-Control with s-maxage and stale-while-revalidate", () => {
    const res = cacheableJson({ ok: true }, READ_CACHE.stats);
    const cacheControl = res.headers.get("Cache-Control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain(`s-maxage=${READ_CACHE.stats.sMaxage}`);
    expect(cacheControl).toContain(`stale-while-revalidate=${READ_CACHE.stats.swr}`);
  });

  it("sets the CC-BY-4.0 license headers", () => {
    const res = cacheableJson({ ok: true }, READ_CACHE.stats);
    expect(res.headers.get("X-License")).toBe("CC-BY-4.0");
    expect(res.headers.get("Link")).toContain("creativecommons.org/licenses/by/4.0");
    expect(res.headers.get("Link")).toContain('rel="license"');
  });

  it("sets X-API-Version", () => {
    const res = cacheableJson({ ok: true }, READ_CACHE.stats);
    expect(res.headers.get("X-API-Version")).toBe(API_VERSION);
  });

  it("publishes the origin alone — this is the assertion that closes the finding", () => {
    // The 2026-09-27 finding was measured on `GET /api/facilities`, whose 200
    // body is built here. So this assertion, not any preflight one, is what
    // stops `access-control-allow-methods: GET, POST, PATCH, DELETE, OPTIONS`
    // and `access-control-allow-headers: Content-Type, Authorization` being
    // served to `https://evil.example` — including on the two mixed paths whose
    // OPTIONS must stay `admin`.
    const res = cacheableJson({ ok: true }, READ_CACHE.stats);

    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
    expect(res.headers.get("access-control-allow-headers")).toBeNull();
  });

  it("uses the sMaxage/swr from the given cache window, not a fixed default", () => {
    const search = cacheableJson({ ok: true }, READ_CACHE.search);
    expect(search.headers.get("Cache-Control")).toContain(`s-maxage=${READ_CACHE.search.sMaxage}`);
    expect(search.headers.get("Cache-Control")).not.toContain(`s-maxage=${READ_CACHE.stats.sMaxage}`);
  });

  it("does not inherit jsonResponse's no-store default", () => {
    // `cacheableJson` builds on `NextResponse.json` directly for exactly this
    // reason. If it were ever refactored to delegate to `jsonResponse`, every
    // public read would become uncacheable — and this project is already at its
    // Vercel bandwidth cap, so that is an outage, not a nit.
    for (const window of Object.values(READ_CACHE)) {
      const res = cacheableJson({ ok: true }, window);

      expect(res.headers.get("Cache-Control")).not.toContain("no-store");
      expect(res.headers.get("CDN-Cache-Control")).toBeNull();
    }
  });
});
