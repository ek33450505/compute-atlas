import { describe, it, expect } from "vitest";
import { GET } from "./route";

function req(query: string): Request {
  return new Request(`http://localhost/api/facilities${query}`);
}

describe("GET /api/facilities", () => {
  it("returns the full dataset with no filters", async () => {
    const res = await GET(req(""));
    const body = await res.json();
    expect(body.count).toBe(310);
    expect(body.facilities.length).toBe(body.count);
  });

  it("carries the shared CORS header", async () => {
    const res = await GET(req(""));
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("narrows by ?status=operational", async () => {
    const res = await GET(req("?status=operational"));
    const body = await res.json();
    expect(body.count).toBeGreaterThan(0);
    expect(body.count).toBeLessThan(310);
    expect(
      body.facilities.every((f: { status: string }) => f.status === "operational")
    ).toBe(true);
  });

  it("narrows by ?type=power_generation", async () => {
    const res = await GET(req("?type=power_generation"));
    const body = await res.json();
    expect(body.count).toBe(5);
  });

  it("accepts comma-separated values for a single param", async () => {
    const res = await GET(req("?status=operational,cancelled"));
    const body = await res.json();
    const single = await (
      await GET(req("?status=operational"))
    ).json();
    const cancelledOnly = await (await GET(req("?status=cancelled"))).json();
    expect(body.count).toBe(single.count + cancelledOnly.count);
  });

  it("accepts repeated params for the same key", async () => {
    const res = await GET(req("?status=operational&status=cancelled"));
    const body = await res.json();
    const single = await (
      await GET(req("?status=operational"))
    ).json();
    const cancelledOnly = await (await GET(req("?status=cancelled"))).json();
    expect(body.count).toBe(single.count + cancelledOnly.count);
  });

  it("drops invalid status tokens instead of erroring, degrading to no constraint", async () => {
    const res = await GET(req("?status=bogus"));
    expect(res.status).toBe(200);
    const body = await res.json();
    // "bogus" is not a valid STATUS_ORDER member, so it's filtered out of the
    // statuses array; an empty statuses array means no status constraint —
    // the full dataset is returned, not zero results.
    expect(body.count).toBe(310);
  });

  it("narrows by ?q= substring", async () => {
    const res = await GET(req("?q=aws"));
    const body = await res.json();
    expect(body.count).toBeGreaterThan(0);
    expect(body.count).toBeLessThan(310);
  });
});
