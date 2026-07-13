import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { requireAdmin } from "./api-auth";

function req(headers?: HeadersInit): Request {
  return new Request("http://localhost/api/facilities", { headers });
}

describe("requireAdmin", () => {
  const ORIGINAL = process.env.API_ADMIN_TOKEN;

  beforeEach(() => {
    delete process.env.API_ADMIN_TOKEN;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.API_ADMIN_TOKEN;
    } else {
      process.env.API_ADMIN_TOKEN = ORIGINAL;
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
});
