/**
 * Route-level wiring for the intake/admin token split.
 *
 * `api-auth.test.ts` proves the two guards behave correctly in isolation; this
 * file proves each route is wired to the RIGHT one, which is the property that
 * actually holds the core invariant up. A unit test of `requireAdmin` cannot
 * fail if a privileged route quietly starts calling `requireIntake` — so these
 * tests invoke the real handlers with a real intake-token request and assert
 * the 401. (Re-pointing `POST /api/facilities` at `requireIntake` must turn the
 * first test in "privileged routes" red; that is the mutation this file exists
 * for.)
 *
 * Every assertion below relies on the handlers checking auth BEFORE parsing a
 * body or touching the DB, so nothing here needs DATABASE_URL. A 401 where a
 * 400 was expected (or vice versa) is therefore also a signal that a handler's
 * ordering moved.
 *
 * It lives in `lib/` rather than beside each route because the routes' own test
 * files are owned elsewhere; the subject under test is the `lib/api-auth.ts`
 * contract across its call sites.
 *
 * Those behavioural cases import a FIXED list of handlers, which is exactly
 * their blind spot: a brand-new `app/**\/route.ts` gated with `requireIntake`
 * is invisible to every one of them, so the staging-only credential could
 * silently gain a capability with the whole suite green. The final describe
 * closes that with a STRUCTURAL scan of the filesystem.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { GET as submissionsGet, POST as submissionsPost } from "@/app/api/submissions/route";
import { POST as facilitiesPost } from "@/app/api/facilities/route";
import { PATCH as facilityPatch, DELETE as facilityDelete } from "@/app/api/facilities/[id]/route";
import { POST as approvePost } from "@/app/api/submissions/[id]/approve/route";

const ADMIN = "admin-token-for-tests";
const INTAKE = "intake-token-for-tests";

const ORIGINAL_ADMIN = process.env.API_ADMIN_TOKEN;
const ORIGINAL_INTAKE = process.env.API_INTAKE_TOKEN;

beforeEach(() => {
  process.env.API_ADMIN_TOKEN = ADMIN;
  process.env.API_INTAKE_TOKEN = INTAKE;
});

afterEach(() => {
  if (ORIGINAL_ADMIN === undefined) delete process.env.API_ADMIN_TOKEN;
  else process.env.API_ADMIN_TOKEN = ORIGINAL_ADMIN;
  if (ORIGINAL_INTAKE === undefined) delete process.env.API_INTAKE_TOKEN;
  else process.env.API_INTAKE_TOKEN = ORIGINAL_INTAKE;
});

function authed(url: string, token: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** The `{ params }` second argument Next 16 passes to a dynamic route. */
function ctx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/submissions (the one intake-token route)", () => {
  it("accepts the intake token", async () => {
    // 400, not 401: past the guard and into envelope validation.
    const res = await submissionsPost(
      authed("http://localhost/api/submissions", INTAKE, "POST", { kind: "not-a-kind" })
    );
    expect(res.status).toBe(400);
  });

  it("still accepts the admin token (admin UI + submissions CLI)", async () => {
    const res = await submissionsPost(
      authed("http://localhost/api/submissions", ADMIN, "POST", { kind: "not-a-kind" })
    );
    expect(res.status).toBe(400);
  });

  it("accepts the admin token when API_INTAKE_TOKEN is unset (production today)", async () => {
    delete process.env.API_INTAKE_TOKEN;
    const res = await submissionsPost(
      authed("http://localhost/api/submissions", ADMIN, "POST", { kind: "not-a-kind" })
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unrelated token", async () => {
    const res = await submissionsPost(
      authed("http://localhost/api/submissions", "nope", "POST", { kind: "not-a-kind" })
    );
    expect(res.status).toBe(401);
  });

  it("rejects the intake token on GET — reading the queue is not intake", async () => {
    const res = await submissionsGet(authed("http://localhost/api/submissions", INTAKE, "GET"));
    expect(res.status).toBe(401);
  });
});

describe("privileged routes reject the intake token", () => {
  it("POST /api/facilities (create a LIVE facility)", async () => {
    const res = await facilitiesPost(
      authed("http://localhost/api/facilities", INTAKE, "POST", { id: "x" })
    );
    expect(res.status).toBe(401);
  });

  it("PATCH /api/facilities/[id] (edit a LIVE facility)", async () => {
    const res = await facilityPatch(
      authed("http://localhost/api/facilities/x", INTAKE, "PATCH", { name: "y" }),
      ctx("x")
    );
    expect(res.status).toBe(401);
  });

  it("DELETE /api/facilities/[id] (retire a LIVE facility)", async () => {
    const res = await facilityDelete(
      authed("http://localhost/api/facilities/x", INTAKE, "DELETE"),
      ctx("x")
    );
    expect(res.status).toBe(401);
  });

  it("POST /api/submissions/[id]/approve (promote WITHOUT human review)", async () => {
    const res = await approvePost(
      authed("http://localhost/api/submissions/x/approve", INTAKE, "POST"),
      ctx("x")
    );
    expect(res.status).toBe(401);
  });
});

describe("privileged routes still accept the admin token", () => {
  // Past the guard: 400 on an invalid body proves the guard did not deny.
  it("POST /api/facilities reaches validation with the admin token", async () => {
    const res = await facilitiesPost(
      authed("http://localhost/api/facilities", ADMIN, "POST", { id: "x" })
    );
    expect(res.status).toBe(400);
  });
});

/**
 * Scanned recursively; every handler under here is a public HTTP surface.
 *
 * `app`, not `app/api`: a Next route handler is any `route.ts` in the App
 * Router tree, and three of the 22 sit outside `app/api` —
 * `app/sitemap.xml/route.ts`, `app/sitemaps/[family]/route.ts` and
 * `app/activity/feed.xml/route.ts`. Rooted at `app/api` this scan could not see
 * them, so a `requireIntake` call in any of the three passed green while the
 * describe below claimed the guard was confined to one handler.
 */
const ROUTE_ROOT = "app";

/** The staging-only guard `app/api/submissions/route.ts` says not to widen. */
const INTAKE_GUARD = "requireIntake";

/**
 * The ONE handler allowed to call it, as a LITERAL path. Deliberately not
 * derived from anything `lib/api-auth.ts` exports: an expectation computed from
 * production code moves when production code moves, so a mutation that
 * re-points the guard would drag the assertion along with it and stay green.
 */
const INTAKE_ROUTE = "app/api/submissions/route.ts";

/**
 * A floor, not an exact count — 22 non-test route files at the time of writing.
 * Every assertion below is over a scanned SET, so a scan that matched nothing
 * would satisfy them all without checking anything.
 *
 * 15 is chosen, not rounded, and the arithmetic is NOT the one that justified
 * 12 when this scanned `app/api`. There, 11 of 19 sat at the shallowest tier,
 * so one break-mode — a scan that stops recursing — landed on one number.
 * Under `app` the files are spread across four tiers, measured, cumulative by
 * depth below the root: 1 at `<segment>/route.ts`, 14 within two segments, 20
 * within three, 22 in all. A truncating scan therefore has three possible
 * landings, not one. 15 is the lowest floor that trips both the one-segment
 * (1) and two-segment (14) truncations, and it still leaves seven files of
 * headroom, so retiring routes needs no edit here.
 *
 * Honest residue: a three-segment truncation finds 20 and clears this floor.
 * No count can catch that without pinning the floor so close to 22 that any
 * retirement reds the suite — so it is caught by naming a deepest-tier file in
 * the case below instead, which is what a count cannot express.
 */
const MIN_ROUTE_FILES = 15;

/**
 * Deepest-tier route, as a LITERAL path, asserted present for the reason in
 * `MIN_ROUTE_FILES`: at five segments below `app` it is the first thing a
 * truncating scan loses and the last thing a count would notice. It is also a
 * privileged handler, so a scan that cannot see it is blind exactly where a
 * misplaced `requireIntake` would matter most.
 */
const DEEPEST_ROUTE = "app/api/submissions/[id]/approve/route.ts";

/**
 * The guard as a CALL, not a substring. `source.includes(INTAKE_GUARD)` is
 * already satisfied by the import and the two prose mentions in the staging
 * route's own doc comment, and would be satisfied by a `// TODO: requireIntake`
 * anywhere else — the invariant would then be measuring documentation, not
 * wiring. `requireIntake` is synchronous and its result is assigned, so there
 * is no `await` to anchor on the way `app/admin/server-actions-guard.test.ts`
 * does; the lookbehind stands in for it, rejecting `auth.requireIntake(` and
 * `notRequireIntake(`.
 *
 * Honest scope: this matches the guard by NAME at the CALL, so two shapes are
 * invisible to it by construction — an aliased import (`import { requireIntake
 * as gate }`, then `gate(request)`) and a namespace import (`import * as
 * auth`, then `auth.requireIntake(request)`, which the lookbehind rejects on
 * purpose). `GUARD_IMPORT` and `GUARD_MEMBER_CALL` below cover one each; the
 * invariant is the three read together, not this pattern alone.
 */
const GUARD_CALL = new RegExp(`(?<![\\w.])${INTAKE_GUARD}\\s*\\(`);

/**
 * The guard in an IMPORT CLAUSE. An alias renames it locally but cannot hide it
 * here: `import { requireIntake as gate }` still spells the exported name, so
 * this sees the shape `GUARD_CALL` provably cannot.
 *
 * `[^;]` on both sides of the identifier, so a match can never span two
 * statements — without it a lazy `[\s\S]*?` would happily bridge an innocent
 * `import … from` on one line to a `requireIntake` far below it. Anchored on a
 * following `from`, which is what makes the statement an import.
 */
const GUARD_IMPORT = new RegExp(
  `import[^;]*?(?<![\\w$])${INTAKE_GUARD}(?![\\w$])[^;]*?\\bfrom\\b`
);

/**
 * The guard as a MEMBER call — `auth.requireIntake(request)` after
 * `import * as auth from "@/lib/api-auth"`. This shape defeats BOTH patterns
 * above, which is why it needs its own: `GUARD_CALL`'s lookbehind rejects a
 * member call deliberately, and a namespace import never spells `requireIntake`
 * in its clause, so `GUARD_IMPORT` has nothing to match. Matching on the `.`
 * alone is enough because the member name is the exported name whatever the
 * namespace was called locally.
 */
const GUARD_MEMBER_CALL = new RegExp(`\\.\\s*${INTAKE_GUARD}\\s*\\(`);

/**
 * Comment-only text removed before the scan: block comments, and lines whose
 * first non-space characters are `//` or a JSDoc `*` continuation.
 *
 * Honest scope, and why it errs in this direction. A TRAILING `// …` comment is
 * deliberately NOT stripped: cutting from the first `//` on a line would also
 * eat a real call sitting after a URL string, which is a false PASS on a
 * security invariant. Left in, a trailing comment naming the guard as a call
 * produces a false FAILURE instead — loud, and the message says what to do. The
 * block strip carries the same exposure in principle (an opening block marker
 * inside a string literal), which is why the case below asserts the intake
 * route STILL matches after stripping: if this ever ate a real call, it reds.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/** Every non-test `route.ts`/`route.tsx` under `app`, repo-relative. */
function routeHandlerFiles(): string[] {
  const entries = readdirSync(join(process.cwd(), ROUTE_ROOT), {
    recursive: true,
    encoding: "utf8",
  });

  return entries
    .filter((entry) => /(^|[\\/])route\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry))
    .map((entry) => `${ROUTE_ROOT}/${entry.split(sep).join("/")}`)
    .sort();
}

describe(`${INTAKE_GUARD} is structurally confined to one handler`, () => {
  it("discovers the route handler files, to every depth", () => {
    const files = routeHandlerFiles();

    expect(
      files.length,
      `Scanned ${ROUTE_ROOT}/ and found only ${files.length} route file(s), below the ` +
        `floor of ${MIN_ROUTE_FILES}. Either the scan broke (most likely: it stopped ` +
        `recursing into nested segments) or the API shrank a lot. Fix the scan — do ` +
        `not lower the floor to match, or the invariant below passes vacuously.`
    ).toBeGreaterThanOrEqual(MIN_ROUTE_FILES);

    expect(
      files,
      `The scan no longer sees ${INTAKE_ROUTE}, so it cannot be checking anything.`
    ).toContain(INTAKE_ROUTE);

    expect(
      files,
      `The scan no longer reaches ${DEEPEST_ROUTE}, the deepest handler in the tree. ` +
        `The floor above cannot catch this — a scan truncated just short of that depth ` +
        `still returns enough files to clear it — so this case is what stands in for it.`
    ).toContain(DEEPEST_ROUTE);
  });

  it("is called by exactly one route, and it is POST /api/submissions", () => {
    const callers = routeHandlerFiles().filter((file) =>
      GUARD_CALL.test(withoutComments(readFileSync(join(process.cwd(), file), "utf8")))
    );

    expect(
      callers,
      `\`${INTAKE_GUARD}\` accepts API_INTAKE_TOKEN — a staging-only credential held ` +
        `by the discovery pipeline, which may stage \`pending\` rows and nothing else. ` +
        `Exactly one route may call it; these do:\n  ${callers.join("\n  ") || "(none)"}\n\n` +
        `If a route was ADDED here: it now accepts that credential, so the pipeline can ` +
        `reach a capability it was scoped out of. Gate it with \`requireAdmin\` instead. ` +
        `If ${INTAKE_ROUTE} DROPPED out: the intake token no longer opens the one door ` +
        `it exists for, and the pipeline is broken. Widening this list is a deliberate ` +
        `change to the token split — say why here and in lib/api-auth.ts.`
    ).toEqual([INTAKE_ROUTE]);
  });

  it("is not reachable from any other route under an alias or a namespace", () => {
    const reaching = routeHandlerFiles().filter((file) => {
      const source = withoutComments(readFileSync(join(process.cwd(), file), "utf8"));
      return GUARD_IMPORT.test(source) || GUARD_MEMBER_CALL.test(source);
    });

    expect(
      reaching,
      `A route can hold \`${INTAKE_GUARD}\` without ever writing \`${INTAKE_GUARD}(\`: ` +
        `\`import { ${INTAKE_GUARD} as gate }\` then \`gate(request)\`, or ` +
        `\`import * as auth\` then \`auth.${INTAKE_GUARD}(request)\`. The case above ` +
        `sees neither. These routes reach it by one of those routes or by name:\n  ` +
        `${reaching.join("\n  ") || "(none)"}\n\n` +
        `Same rule as above — exactly one handler may hold this credential. If ` +
        `${INTAKE_ROUTE} dropped out, its import is gone and the pipeline is broken.`
    ).toEqual([INTAKE_ROUTE]);
  });

  it("measures calls, not mentions", () => {
    // Keeps the predicate honest. The staging route names the guard four times
    // — an import, two prose mentions, one call — so a substring test would be
    // satisfied by its documentation, and a stray comment in any OTHER route
    // would fail the invariant for no reason. Neither may happen.
    expect(GUARD_CALL.test(`import { requireAdmin, ${INTAKE_GUARD} } from "@/lib/api-auth";`)).toBe(
      false
    );
    expect(GUARD_CALL.test(` * Do not widen \`${INTAKE_GUARD}\` past this handler.`)).toBe(false);
    expect(GUARD_CALL.test(`auth.${INTAKE_GUARD}(request)`)).toBe(false);
    expect(withoutComments(`  // TODO: ${INTAKE_GUARD}(request)`)).not.toMatch(GUARD_CALL);

    // …and still sees the real thing, in the form the route actually uses.
    expect(GUARD_CALL.test(`  const denied = ${INTAKE_GUARD}(request);`)).toBe(true);
  });

  it("sees an alias and a namespace, which a call-site pattern cannot", () => {
    // The two evasions the case above is blind to, each pinned against the
    // pattern that catches it — and against a near-miss that must NOT match, so
    // neither pattern degenerates into a substring test.
    expect(
      GUARD_IMPORT.test(`import { requireAdmin, ${INTAKE_GUARD} as gate } from "@/lib/api-auth";`)
    ).toBe(true);
    expect(GUARD_IMPORT.test(`import { requireAdmin } from "@/lib/api-auth";`)).toBe(false);
    expect(GUARD_IMPORT.test(`const denied = ${INTAKE_GUARD}(request);`)).toBe(false);

    // A statement boundary the `[^;]` bounds must not be bridged: an innocent
    // import, then the identifier, then a later `from` — three lines that would
    // match if the pattern were allowed to span statements.
    expect(
      GUARD_IMPORT.test(
        `import { requireAdmin } from "@/lib/api-auth";\nconst x = ${INTAKE_GUARD};\nconst from = 1;`
      )
    ).toBe(false);

    expect(GUARD_MEMBER_CALL.test(`  const denied = auth.${INTAKE_GUARD}(request);`)).toBe(true);
    expect(GUARD_MEMBER_CALL.test(`import * as auth from "@/lib/api-auth";`)).toBe(false);

    // Honest residue, and it is narrow. Both patterns read the ROUTE file, so
    // two indirections survive: a renamed dynamic import
    // (`const { requireIntake: gate } = await import("@/lib/api-auth")`), which
    // has no `from` clause and no member call; and a second module that
    // re-exports the guard under a different name, which leaves nothing in the
    // route to match. Neither shape exists in this app, and neither is
    // something a route arrives at by accident.
  });
});
