import { describe, it, expect } from "vitest";
import { GET, POST } from "./route";

function req(method: string, body?: unknown, headers?: HeadersInit): Request {
  return new Request("http://localhost/api/submissions", {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("GET /api/submissions", () => {
  it("rejects a request with no admin token", async () => {
    const res = await GET(req("GET"));
    expect(res.status).toBe(401);
  });

  it("rejects an invalid ?status= value before touching the database", async () => {
    process.env.API_ADMIN_TOKEN = "test-token";
    const res = await GET(
      new Request("http://localhost/api/submissions?status=bogus", {
        headers: { Authorization: "Bearer test-token" },
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});

describe("POST /api/submissions", () => {
  it("rejects a request with no admin token", async () => {
    const res = await POST(req("POST", { kind: "create" }));
    expect(res.status).toBe(401);
  });

  it("rejects an invalid envelope before touching the database", async () => {
    process.env.API_ADMIN_TOKEN = "test-token";
    const res = await POST(
      req("POST", { kind: "not-a-kind" }, { Authorization: "Bearer test-token" })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});
