// @vitest-environment node
import { describe, expect, it } from "vitest";

import { formRedirect, readFormToken } from "@/lib/access-form";

const TOKEN = "A".repeat(43);
const post = (body: string) => new Request("http://localhost/api/access/confirm", { method: "POST", body });

describe("readFormToken", () => {
  it("returns a well-formed token", async () => {
    expect(await readFormToken(post(`token=${TOKEN}`))).toBe(TOKEN);
  });

  it.each([
    ["an empty body", ""],
    ["a missing token", "other=1"],
    ["a malformed token", "token=short"],
    ["an oversize body", `token=${TOKEN}&pad=${"x".repeat(5000)}`],
  ])("returns null for %s", async (_name, body) => {
    expect(await readFormToken(post(body))).toBeNull();
  });
});

describe("formRedirect", () => {
  it("is a 303 to the hardcoded same-origin path with both no-store headers", () => {
    const res = formRedirect(post(""), "/access/confirmed");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("http://localhost/access/confirmed");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
  });
});
