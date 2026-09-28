import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { requireAdmin, requireIntake } from "./api-auth";

function req(headers?: HeadersInit): Request {
  return new Request("http://localhost/api/facilities", { headers });
}

describe("requireAdmin", () => {
  const ORIGINAL = process.env.API_ADMIN_TOKEN;
  const ORIGINAL_INTAKE = process.env.API_INTAKE_TOKEN;

  beforeEach(() => {
    delete process.env.API_ADMIN_TOKEN;
    delete process.env.API_INTAKE_TOKEN;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.API_ADMIN_TOKEN;
    } else {
      process.env.API_ADMIN_TOKEN = ORIGINAL;
    }
    if (ORIGINAL_INTAKE === undefined) {
      delete process.env.API_INTAKE_TOKEN;
    } else {
      process.env.API_INTAKE_TOKEN = ORIGINAL_INTAKE;
    }
  });

  it("fails closed when API_ADMIN_TOKEN is unset", async () => {
    const res = requireAdmin(req({ Authorization: "Bearer anything" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("rejects a request with no Authorization header", async () => {
    process.env.API_ADMIN_TOKEN = "secret-token";
    const res = requireAdmin(req());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("rejects a malformed Authorization header (wrong scheme)", async () => {
    process.env.API_ADMIN_TOKEN = "secret-token";
    const res = requireAdmin(req({ Authorization: "Basic xyz" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("rejects a Bearer header with no token", async () => {
    process.env.API_ADMIN_TOKEN = "secret-token";
    const res = requireAdmin(req({ Authorization: "Bearer" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("rejects the wrong token", async () => {
    process.env.API_ADMIN_TOKEN = "secret-token";
    const res = requireAdmin(req({ Authorization: "Bearer wrong-token" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("accepts the correct token", async () => {
    process.env.API_ADMIN_TOKEN = "secret-token";
    const res = requireAdmin(req({ Authorization: "Bearer secret-token" }));
    expect(res).toBeNull();
  });

  it("carries the shared CORS header on a 401", async () => {
    const res = requireAdmin(req());
    expect(res!.headers.get("access-control-allow-origin")).toBe("*");
  });

  // The whole point of the split: the staging credential must not open a
  // full-privilege route, even when it is configured and valid for intake.
  it("rejects the intake token", async () => {
    process.env.API_ADMIN_TOKEN = "admin-token";
    process.env.API_INTAKE_TOKEN = "intake-token";
    const res = requireAdmin(req({ Authorization: "Bearer intake-token" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("stays closed when only API_INTAKE_TOKEN is configured", async () => {
    process.env.API_INTAKE_TOKEN = "intake-token";
    const res = requireAdmin(req({ Authorization: "Bearer intake-token" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });
});

describe("requireIntake", () => {
  const ORIGINAL = process.env.API_ADMIN_TOKEN;
  const ORIGINAL_INTAKE = process.env.API_INTAKE_TOKEN;

  beforeEach(() => {
    delete process.env.API_ADMIN_TOKEN;
    delete process.env.API_INTAKE_TOKEN;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.API_ADMIN_TOKEN;
    } else {
      process.env.API_ADMIN_TOKEN = ORIGINAL;
    }
    if (ORIGINAL_INTAKE === undefined) {
      delete process.env.API_INTAKE_TOKEN;
    } else {
      process.env.API_INTAKE_TOKEN = ORIGINAL_INTAKE;
    }
  });

  it("fails closed when BOTH tokens are unset", async () => {
    const res = requireIntake(req({ Authorization: "Bearer anything" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("accepts the intake token", async () => {
    process.env.API_INTAKE_TOKEN = "intake-token";
    expect(requireIntake(req({ Authorization: "Bearer intake-token" }))).toBeNull();
  });

  // Backwards compatibility: the admin UI, the `submissions` CLI, and the
  // discovery pipeline all still present API_ADMIN_TOKEN here until Ed sets
  // API_INTAKE_TOKEN in production. Breaking this breaks the nightly run.
  it("accepts the admin token when API_INTAKE_TOKEN is unset", async () => {
    process.env.API_ADMIN_TOKEN = "admin-token";
    expect(requireIntake(req({ Authorization: "Bearer admin-token" }))).toBeNull();
  });

  it("accepts EITHER token when both are configured", async () => {
    process.env.API_ADMIN_TOKEN = "admin-token";
    process.env.API_INTAKE_TOKEN = "intake-token";
    expect(requireIntake(req({ Authorization: "Bearer intake-token" }))).toBeNull();
    expect(requireIntake(req({ Authorization: "Bearer admin-token" }))).toBeNull();
  });

  it("rejects a token that is neither", async () => {
    process.env.API_ADMIN_TOKEN = "admin-token";
    process.env.API_INTAKE_TOKEN = "intake-token";
    const res = requireIntake(req({ Authorization: "Bearer some-other-token" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("requires the Bearer prefix", async () => {
    process.env.API_INTAKE_TOKEN = "intake-token";
    const res = requireIntake(req({ Authorization: "intake-token" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("rejects a Bearer header with no token", async () => {
    process.env.API_INTAKE_TOKEN = "intake-token";
    const res = requireIntake(req({ Authorization: "Bearer" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("rejects an empty-string intake token as unconfigured", async () => {
    process.env.API_INTAKE_TOKEN = "";
    const res = requireIntake(req({ Authorization: "Bearer " }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("carries the shared CORS header on a 401", async () => {
    const res = requireIntake(req());
    expect(res!.headers.get("access-control-allow-origin")).toBe("*");
  });
});
