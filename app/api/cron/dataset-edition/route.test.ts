// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { buildEditionMock, getDbMock, isEnabledMock } = vi.hoisted(() => ({
  buildEditionMock: vi.fn(),
  getDbMock: vi.fn(),
  isEnabledMock: vi.fn(),
}));

vi.mock("@/lib/dataset-edition-builder", () => ({ buildEdition: buildEditionMock }));
vi.mock("@/lib/dataset-flag", () => ({ isDatasetSharingEnabled: isEnabledMock }));
// The route itself must never touch the DB; the (mocked) builder owns all of it.
vi.mock("@/lib/db/client", () => ({ getDb: getDbMock }));

import * as routeModule from "./route";
import { GET, dynamic, maxDuration } from "./route";

const SECRET = "cron-secret-for-tests";

function req(headers?: HeadersInit): Request {
  return new Request("http://localhost/api/cron/dataset-edition", { headers });
}
const bearer = { authorization: `Bearer ${SECRET}` };

function expectNoStore(res: Response) {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("cdn-cache-control")).toBe("no-store");
}

describe("GET /api/cron/dataset-edition", () => {
  const saved = { ...process.env };
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = SECRET;
    delete process.env.API_ADMIN_TOKEN;
    isEnabledMock.mockReturnValue(true);
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  function expectUntouched() {
    expect(buildEditionMock).not.toHaveBeenCalled();
    expect(getDbMock).not.toHaveBeenCalled();
  }

  it("exports the route segment config", () => {
    expect(maxDuration).toBe(300);
    expect(dynamic).toBe("force-dynamic");
  });

  it("exports only GET", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(routeModule).not.toHaveProperty(method);
    }
  });

  describe("auth (first, fail closed)", () => {
    it("401s with no authorization header", async () => {
      const res = await GET(req());
      expect(res.status).toBe(401);
      expectNoStore(res);
      expectUntouched();
    });

    it("401s with a wrong bearer", async () => {
      const res = await GET(req({ authorization: "Bearer nope" }));
      expect(res.status).toBe(401);
      expectNoStore(res);
      expectUntouched();
    });

    it("401s with any bearer when CRON_SECRET is unset", async () => {
      delete process.env.CRON_SECRET;
      const res = await GET(req(bearer));
      expect(res.status).toBe(401);
      expectUntouched();
    });

    it("does not accept the admin bearer", async () => {
      process.env.API_ADMIN_TOKEN = "admin-token-for-tests";
      const res = await GET(req({ authorization: "Bearer admin-token-for-tests" }));
      expect(res.status).toBe(401);
      expectUntouched();
    });

    it("401s (not the skipped body) when the flag is off and there is no bearer", async () => {
      isEnabledMock.mockReturnValue(false);
      const res = await GET(req());
      expect(res.status).toBe(401);
      expect(await res.json()).not.toHaveProperty("skipped");
      // the kill switch is not even consulted before auth passes
      expect(isEnabledMock).not.toHaveBeenCalled();
      expectUntouched();
    });
  });

  describe("kill switch (strictly after auth)", () => {
    it("200s skipped:disabled with no DB access and no build when the flag is off", async () => {
      isEnabledMock.mockReturnValue(false);
      const res = await GET(req(bearer));
      expect(res.status).toBe(200);
      expectNoStore(res);
      expect(await res.json()).toEqual({ ok: true, skipped: "disabled" });
      expectUntouched();
    });
  });

  describe("build outcomes", () => {
    it("published: 200 with the fixed body shape", async () => {
      buildEditionMock.mockResolvedValue({
        outcome: "published",
        editionId: "ed-1",
        editionDate: "2026-11-14",
        recordCount: 2300,
      });
      const res = await GET(req(bearer));
      expect(buildEditionMock).toHaveBeenCalledTimes(1);
      // the cron must not be held off by the admin-click retry cooldown
      expect(buildEditionMock).toHaveBeenCalledWith({ ignoreRetryCooldown: true });
      // a published run logs nothing here
      expect(infoSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
      expectNoStore(res);
      expect(await res.json()).toEqual({
        ok: true,
        outcome: "published",
        editionId: "ed-1",
        editionDate: "2026-11-14",
        recordCount: 2300,
      });
      expect(getDbMock).not.toHaveBeenCalled();
    });

    it.each(["alreadyPublished", "inProgress"] as const)("%s: 200 ok:true", async (outcome) => {
      buildEditionMock.mockResolvedValue({ outcome, editionId: "ed-2", editionDate: "2026-11-14" });
      const res = await GET(req(bearer));
      expect(res.status).toBe(200);
      expectNoStore(res);
      expect(await res.json()).toEqual({
        ok: true,
        outcome,
        editionId: "ed-2",
        editionDate: "2026-11-14",
      });
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy).toHaveBeenCalledWith(`dataset edition cron: ${outcome} 2026-11-14`);
    });

    it("logs one error line when the notice pass was cut short, and leaves the response body unchanged", async () => {
      buildEditionMock.mockResolvedValue({
        outcome: "published",
        editionId: "ed-1",
        editionDate: "2026-11-14",
        recordCount: 2300,
        notices: { complete: false, sent: 42 },
      });
      const res = await GET(req(bearer));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        outcome: "published",
        editionId: "ed-1",
        editionDate: "2026-11-14",
        recordCount: 2300,
      });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith("dataset edition cron: notices incomplete 2026-11-14 (sent: 42)");
    });

    it("an incomplete resume pass (alreadyPublished) is logged the same way", async () => {
      buildEditionMock.mockResolvedValue({
        outcome: "alreadyPublished",
        editionId: "ed-2",
        editionDate: "2026-11-14",
        notices: { complete: false, sent: 3 },
      });
      await GET(req(bearer));
      expect(errorSpy).toHaveBeenCalledWith("dataset edition cron: notices incomplete 2026-11-14 (sent: 3)");
    });

    it("stays quiet when the notice pass completed or did not run", async () => {
      buildEditionMock.mockResolvedValue({
        outcome: "published",
        editionId: "ed-1",
        editionDate: "2026-11-14",
        recordCount: 2300,
        notices: { complete: true, sent: 5 },
      });
      await GET(req(bearer));
      buildEditionMock.mockResolvedValue({ outcome: "published", editionId: "ed-1", editionDate: "2026-11-14", recordCount: 2300 });
      await GET(req(bearer));
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("failed: 500 with the code and no message, stack or extra keys", async () => {
      buildEditionMock.mockResolvedValue({
        outcome: "failed",
        editionId: "ed-3",
        editionDate: "2026-11-14",
        code: "snapshot_below_floor",
        // a hostile/accidental extra field must not be relayed
        message: "Failed query: select ... params: secret@example.com",
        stack: "Error: boom\n    at x",
      });
      const res = await GET(req(bearer));
      expect(res.status).toBe(500);
      expectNoStore(res);
      const body = await res.json();
      expect(body).toEqual({
        ok: false,
        outcome: "failed",
        editionId: "ed-3",
        editionDate: "2026-11-14",
        code: "snapshot_below_floor",
      });
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/secret@example|Failed query|stack|boom/);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith("dataset edition cron: failed 2026-11-14 (code: snapshot_below_floor)");
    });

    it("failed without an edition id: omits editionId", async () => {
      buildEditionMock.mockResolvedValue({
        outcome: "failed",
        editionDate: "2026-11-14",
        code: "claim",
      });
      const res = await GET(req(bearer));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        ok: false,
        outcome: "failed",
        editionDate: "2026-11-14",
        code: "claim",
      });
    });
  });
});
