import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("GET /api/stats", () => {
  it("returns the aggregate stats shape", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      count: expect.any(Number),
      states: expect.any(Number),
      operationalMw: expect.any(Number),
      plannedMw: expect.any(Number),
      underConstructionMw: expect.any(Number),
    });
    expect(body.count).toBe(310);
  });

  it("carries the shared CORS header", async () => {
    const res = await GET();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
