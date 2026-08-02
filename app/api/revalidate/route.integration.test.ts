// @vitest-environment node
import { beforeAll, describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));

import { revalidateTag } from "next/cache";

// Import the route handler AFTER the mock above so its transitive import of
// `next/cache` resolves against the mocked module.
import { POST } from "./route";

function req(body: unknown, token: string | null = "test-token"): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) {
    headers.Authorization = `Bearer ${token}`;
  }
  return new Request("http://localhost/api/revalidate", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  process.env.API_ADMIN_TOKEN = "test-token";
});

describe("POST /api/revalidate (auth)", () => {
  it("401s with no Authorization header", async () => {
    const res = await POST(req({ tags: ["facilities"] }, null));
    expect(res.status).toBe(401);
  });

  it("401s with the wrong bearer token", async () => {
    const res = await POST(req({ tags: ["facilities"] }, "wrong-token"));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/revalidate (validation)", () => {
  it("400s on missing tags", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });

  it("400s on an empty tags array", async () => {
    const res = await POST(req({ tags: [] }));
    expect(res.status).toBe(400);
  });

  it("400s and names the offending tag for an unknown literal shape", async () => {
    const res = await POST(req({ tags: ["evil"] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("evil");
  });

  it("400s and names the offending tag for a malformed state shape", async () => {
    const res = await POST(req({ tags: ["state:california"] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("state:california");
  });

  it("400s when tags is not an array", async () => {
    const res = await POST(req({ tags: "facilities" }));
    expect(res.status).toBe(400);
  });

  it("400s when a tags element is not a string", async () => {
    const res = await POST(req({ tags: [123] }));
    expect(res.status).toBe(400);
  });

  it("400s when the top-level body is not an object", async () => {
    const res = await POST(req([]));
    expect(res.status).toBe(400);
  });

  it("400s when the tags array exceeds MAX_TAGS", async () => {
    const tags = Array.from({ length: 101 }, (_, i) => `facility:test-${i}`);
    const res = await POST(req({ tags }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/revalidate (authorized happy path)", () => {
  it("200s on valid tags and calls revalidateTag once per tag with the 'max' profile", async () => {
    vi.mocked(revalidateTag).mockClear();
    const tags = ["facilities", "state:CA", "facility:foo-bar-ca", "power-generation"];

    const res = await POST(req({ tags }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.revalidated).toEqual(tags);
    expect(revalidateTag).toHaveBeenCalledTimes(tags.length);
    for (const tag of tags) {
      expect(revalidateTag).toHaveBeenCalledWith(tag, "max");
    }
  });
});
