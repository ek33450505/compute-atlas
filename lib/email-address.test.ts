import { describe, expect, it } from "vitest";

import { normalizeEmail } from "@/lib/email-address";

describe("normalizeEmail", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeEmail("  foo@x.com\t\n")).toBe("foo@x.com");
  });

  it("lowercases mixed case", () => {
    expect(normalizeEmail("Foo.Bar@X.COM")).toBe("foo.bar@x.com");
  });

  it("leaves an already-normal address unchanged", () => {
    expect(normalizeEmail("foo@x.com")).toBe("foo@x.com");
  });

  it("applies String#toLowerCase to non-ASCII uppercase letters (pins current behaviour)", () => {
    expect(normalizeEmail("ÉLAN@X.com")).toBe("élan@x.com");
  });

  it("does not touch interior whitespace", () => {
    expect(normalizeEmail("a b@x.com")).toBe("a b@x.com");
  });
});
