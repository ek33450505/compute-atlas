import { describe, it, expect } from "vitest";
import { GET } from "./route";

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/facilities/[id]", () => {
  it("returns 200 with the matching facility for a known id", async () => {
    const id = "talen-susquehanna-aws-pa";
    const res = await GET(new Request(`http://localhost/api/facilities/${id}`), params(id));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const facility = await res.json();
    expect(facility.id).toBe(id);
  });

  it("returns 404 with an error for an unknown id", async () => {
    const id = "not-a-real-facility";
    const res = await GET(new Request(`http://localhost/api/facilities/${id}`), params(id));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.id).toBe(id);
  });
});
