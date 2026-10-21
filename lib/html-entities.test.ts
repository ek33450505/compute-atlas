import { describe, it, expect } from "vitest";

import { decodeEntities } from "./html-entities";

describe("decodeEntities", () => {
  it.each([
    ["&amp;", "&"],
    ["&lt;&gt;", "<>"],
    ["&quot;", '"'],
    ["&#39;", "'"],
    ["a&nbsp;b", "a b"],
    ["&#65;", "A"],
    ["&#x41;", "A"],
    ["&#X1F600;", "\u{1F600}"],
    ["&#1114111;", "\u{10FFFF}"],
    ["plain text", "plain text"],
    ["", ""],
  ])("decodes %j", (input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });

  it.each([
    "&#0;",
    "&#55296;",
    "&#56320;",
    "&#1114112;",
    "&#99999999999999999999;",
    "&#xD800;",
    "&#x110000;",
    "&#xFFFFFFFFFFFF;",
    "&#x0;",
    "&#" + "9".repeat(400) + ";",
    "&#x" + "F".repeat(400) + ";",
  ])("maps unstorable %j to U+FFFD without throwing", (input) => {
    expect(decodeEntities(input)).toBe("�");
  });

  it("decodes in one pass, so an escaped ampersand is not re-decoded", () => {
    expect(decodeEntities("&amp;#65;")).toBe("&#65;");
    expect(decodeEntities("&amp;amp;")).toBe("&amp;");
  });

  it("leaves empty numeric references untouched", () => {
    expect(decodeEntities("&#x;")).toBe("&#x;");
    expect(decodeEntities("&#;")).toBe("&#;");
  });

  it("does not widen the named set", () => {
    expect(decodeEntities("&copy; &apos;")).toBe("&copy; &apos;");
  });
});
