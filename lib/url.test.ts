import { describe, it, expect } from "vitest";
import { safeExternalHref } from "./url";

describe("safeExternalHref", () => {
  it("returns the url for http:// urls", () => {
    expect(safeExternalHref("http://example.com")).toBe("http://example.com");
  });

  it("returns the url for https:// urls", () => {
    expect(safeExternalHref("https://example.com/path?x=1")).toBe(
      "https://example.com/path?x=1"
    );
  });

  it("rejects javascript: urls", () => {
    expect(safeExternalHref("javascript:alert(1)")).toBeUndefined();
  });

  it("rejects data: urls", () => {
    expect(
      safeExternalHref("data:text/html,<script>alert(1)</script>")
    ).toBeUndefined();
  });

  it("rejects file: urls", () => {
    expect(safeExternalHref("file:///etc/passwd")).toBeUndefined();
  });

  it("rejects blob: urls", () => {
    expect(safeExternalHref("blob:https://example.com/uuid")).toBeUndefined();
  });

  it("rejects uppercase protocol variants (HTTPS:)", () => {
    // The URL constructor lowercases `protocol`, but the scheme itself is
    // disallowed here only if it isn't actually http/https after parsing —
    // this case demonstrates uppercase-scheme javascript: is still rejected.
    expect(safeExternalHref("JavaScript:alert(1)")).toBeUndefined();
  });

  it("accepts uppercase HTTPS scheme (normalized by URL parser)", () => {
    expect(safeExternalHref("HTTPS://example.com")).toBe("HTTPS://example.com");
  });

  it("returns undefined for an empty string", () => {
    expect(safeExternalHref("")).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(safeExternalHref(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(safeExternalHref(undefined)).toBeUndefined();
  });

  it("returns undefined for a non-URL garbage string", () => {
    expect(safeExternalHref("not a url at all")).toBeUndefined();
  });
});
