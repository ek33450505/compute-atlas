import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("GET /api/schema", () => {
  it("returns a JSON-Schema-shaped object without throwing", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
    const looksLikeJsonSchema =
      "type" in body || "properties" in body || "$schema" in body || "anyOf" in body;
    expect(looksLikeJsonSchema).toBe(true);
  });

  it("carries the shared CORS header", async () => {
    const res = await GET();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
