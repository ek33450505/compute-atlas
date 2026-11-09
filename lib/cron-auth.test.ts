// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client");
// The state-digest route imports lib/notify (and so resend); nothing here may reach either.
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: vi.fn() } };
  }),
}));

import { GET as stateDigestGET } from "@/app/api/cron/state-digest/route";
import { hasValidCronSecret } from "@/lib/cron-auth";

const SECRET = "cron-secret-for-tests";

interface Case {
  name: string;
  secret: string | undefined;
  header: string | null;
  valid: boolean;
}

const CASES: Case[] = [
  { name: "unset secret, bearer presented", secret: undefined, header: `Bearer ${SECRET}`, valid: false },
  { name: "empty secret, empty bearer", secret: "", header: "Bearer ", valid: false },
  { name: "empty secret, bearer presented", secret: "", header: `Bearer ${SECRET}`, valid: false },
  { name: "missing header", secret: SECRET, header: null, valid: false },
  { name: "wrong scheme", secret: SECRET, header: `Basic ${SECRET}`, valid: false },
  { name: "lowercase scheme", secret: SECRET, header: `bearer ${SECRET}`, valid: false },
  { name: "token with no scheme", secret: SECRET, header: SECRET, valid: false },
  { name: "Bearer with nothing after", secret: SECRET, header: "Bearer ", valid: false },
  { name: "Bearer with only whitespace after", secret: SECRET, header: "Bearer    ", valid: false },
  { name: "wrong token, same length", secret: SECRET, header: `Bearer ${"x".repeat(SECRET.length)}`, valid: false },
  { name: "shorter token", secret: SECRET, header: `Bearer ${SECRET.slice(0, -1)}`, valid: false },
  { name: "longer token", secret: SECRET, header: `Bearer ${SECRET}x`, valid: false },
  { name: "whitespace-padded right token", secret: SECRET, header: `Bearer   ${SECRET}  `, valid: true },
  { name: "right token", secret: SECRET, header: `Bearer ${SECRET}`, valid: true },
];

function req(header: string | null): Request {
  return new Request("http://localhost/api/cron/state-digest", {
    headers: header === null ? undefined : { authorization: header },
  });
}

describe("hasValidCronSecret", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env.API_ADMIN_TOKEN;
    delete process.env.STATE_DIGEST_ENABLED;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  for (const c of CASES) {
    it(`${c.valid ? "accepts" : "rejects"}: ${c.name}`, () => {
      if (c.secret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = c.secret;
      expect(hasValidCronSecret(req(c.header))).toBe(c.valid);
    });
  }

  // The state-digest route keeps its own private copy (consolidating it onto this module is a
  // separate follow-up). With STATE_DIGEST_ENABLED unset and no admin token, its auth-then-
  // kill-switch order makes the status code a direct probe of that copy: 401 = rejected by
  // auth (both the cron check and the requireAdmin fallback), 503 = auth passed, kill switch hit.
  describe("equivalence with the state-digest route's private copy", () => {
    for (const c of CASES) {
      it(`agrees on: ${c.name}`, async () => {
        if (c.secret === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = c.secret;
        const res = await stateDigestGET(req(c.header));
        expect(res.status).toBe(c.valid ? 503 : 401);
        expect(hasValidCronSecret(req(c.header))).toBe(res.status === 503);
      });
    }
  });
});
