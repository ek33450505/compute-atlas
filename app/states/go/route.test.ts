import { describe, it, expect } from "vitest";

import { GET, HEAD } from "./route";

const call = (qs: string) => GET(new Request(`https://www.compute-atlas.com/states/go${qs}`));

describe("GET /states/go", () => {
  it("303s a valid code to its hub, case-insensitively", () => {
    for (const qs of ["?state=TX", "?state=tx"]) {
      const res = call(qs);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/states/texas");
    }
  });

  it("resolves a multi-word jurisdiction through the slug table", () => {
    expect(call("?state=DC").headers.get("location")).toBe("/states/district-of-columbia");
  });

  it.each([
    ["missing", ""],
    ["empty", "?state="],
    ["unknown code", "?state=ZZ"],
    ["too long", "?state=TXX"],
    ["array", "?state=TX&state=VA"],
    ["url", "?state=https://evil.example"],
    ["scheme-relative", "?state=//evil.example"],
    ["encoded newline", "?state=T%0AX"],
    ["slug form", "?state=texas"],
    ["dotless i folds to IN", "?state=%C4%B1n"],
    ["Kelvin sign + letter", "?state=%E2%84%AAy"],
    ["encoded slash", "?state=%2F"],
    ["backslash", "?state=%5C"],
  ])("sends %s to the /states index", (_label, qs) => {
    const res = call(qs);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/states");
  });

  it("answers HEAD exactly like GET", () => {
    const res = HEAD(new Request("https://www.compute-atlas.com/states/go?state=TX", { method: "HEAD" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/states/texas");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("is never cached", () => {
    expect(call("?state=TX").headers.get("cache-control")).toBe("no-store");
  });
});
