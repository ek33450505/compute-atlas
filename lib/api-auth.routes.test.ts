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
 */
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
