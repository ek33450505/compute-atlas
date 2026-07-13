import { describe, it, expect } from "vitest";
import { POST } from "./route";

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function req(id: string, body?: unknown): Request {
  return new Request(`http://localhost/api/submissions/${id}/reject`, {
    method: "POST",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("POST /api/submissions/[id]/reject", () => {
  it("rejects a request with no admin token", async () => {
    const res = await POST(req("some-id", { reason: "test" }), params("some-id"));
    expect(res.status).toBe(401);
  });
});
