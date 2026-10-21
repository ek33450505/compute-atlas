import { describe, it, expect } from "vitest";
import { formatAsOfDate } from "@/lib/as-of";

describe("formatAsOfDate", () => {
  it("formats in UTC so a late-evening UTC timestamp keeps its calendar day", () => {
    expect(formatAsOfDate("2026-10-20T23:59:59Z")).toBe("October 20, 2026");
    expect(formatAsOfDate("2026-10-21T00:00:01Z")).toBe("October 21, 2026");
  });

  it("returns null for unknown and unparseable values", () => {
    expect(formatAsOfDate("unknown")).toBeNull();
    expect(formatAsOfDate("not a date")).toBeNull();
  });
});
