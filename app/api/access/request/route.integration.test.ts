// @vitest-environment node
import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/client");

const resendSendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function MockResend() {
    return { emails: { send: resendSendMock } };
  }),
}));

import * as dbClient from "@/lib/db/client";

// Imported after the mocks above so the mocked modules are in effect.
import { POST, OPTIONS } from "./route";

beforeEach(() => {
  vi.mocked(dbClient.getDb).mockClear();
  resendSendMock.mockReset();
});

describe("POST /api/access/request — refused", () => {
  it("answers 403 no-store with the terse body, touching no database and sending no email", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");

    const res = POST();
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ error: "Not available" });

    expect(dbClient.getDb).not.toHaveBeenCalled();
    expect(resendSendMock).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

    it("keeps a CORS preflight answer", () => {
    expect(OPTIONS().status).toBeLessThan(300);
  });
});
