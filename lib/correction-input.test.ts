import { describe, it, expect } from "vitest";

import type { CorrectableKey } from "@/lib/contribute-fields";
import {
  correctionNumberHint,
  isHttpUrl,
  normalizeSourceUrl,
  parseCorrectionNumber,
} from "@/lib/correction-input";

const CAPACITY_ERROR = "Enter a number in megawatts, like 300 or 1.2 GW.";
const SUBSIDY_ERROR = "Enter a dollar amount, like 12,500,000 or 12.5M.";
const JOBS_ERROR = "Enter a whole number, like 1,200.";
const ZERO_ERROR = "Enter a number greater than 0.";

type Case = readonly [raw: string, expected: number];

describe("parseCorrectionNumber — valid input", () => {
  const capacity: Case[] = [
    ["300", 300],
    ["1,200", 1200],
    ["1,200.5 MW", 1200.5],
    ["300 MW", 300],
    ["300mw", 300],
    ["300 megawatts", 300],
    ["1.2 GW", 1200],
    ["1.2gw", 1200],
    ["1.2 Gigawatts", 1200],
    ["1.2   GW", 1200], // internal whitespace collapsed
    ["  300  ", 300],
    ["$300", 300], // one leading $ is dropped
    [".5 GW", 500],
    ["300.", 300],
    // Float noise: 2.01 × 1000 is 2009.9999999999998 and 32.3 × 1000 is
    // 32299.999999999996, but the user typed 2010 and 32300.
    ["2.01 GW", 2010],
    ["32.3 GW", 32_300],
  ];

  it.each(capacity)("capacityOperationalMw: %j -> %d", (raw, expected) => {
    expect(parseCorrectionNumber(raw, "capacityOperationalMw")).toEqual({ ok: true, value: expected });
  });

  it("accepts the same input for capacityPlannedMw", () => {
    expect(parseCorrectionNumber("2 gw", "capacityPlannedMw")).toEqual({ ok: true, value: 2000 });
  });

  const subsidies: Case[] = [
    ["12,500,000", 12_500_000],
    ["$12.5M", 12_500_000],
    ["$ 12.5M", 12_500_000],
    ["12.5 million", 12_500_000],
    ["3mm", 3_000_000],
    ["4mn", 4_000_000],
    ["1.2B", 1_200_000_000],
    ["1.2bn", 1_200_000_000],
    ["7 billion", 7_000_000_000],
    ["500k", 500_000],
    ["2 thousand", 2000],
    ["750", 750],
    // Float noise: 8.2 × 1e6 is 8199999.999999999 and 4.1 × 1e6 is
    // 4099999.9999999995; the stored value must be what was typed.
    ["8.2M", 8_200_000],
    ["4.1M", 4_100_000],
    ["8.2B", 8_200_000_000],
    // 14 significant digits: scaling must not round to 12.
    ["12,345,678,901,234", 12_345_678_901_234],
  ];

  it.each(subsidies)("subsidies: %j -> %d", (raw, expected) => {
    expect(parseCorrectionNumber(raw, "subsidies")).toEqual({ ok: true, value: expected });
  });

  const jobs: Case[] = [
    ["1,200", 1200],
    ["300", 300],
    ["2.5k", 2500],
    ["1.2k", 1200],
    ["1.55K", 1550],
    // 16.1 × 1000 is 16100.000000000002 in floating point, which is not an
    // integer; it must still count as the whole number that was typed.
    ["16.1k", 16_100],
    ["2.01k", 2010],
    // The largest whole number the server accepts. Float scaling lands on
    // ...990 here; scaling the decimal text is exact.
    ["9,007,199,254,740,991", Number.MAX_SAFE_INTEGER],
    ["9,007,199,254,740.991k", Number.MAX_SAFE_INTEGER],
  ];

  it.each(jobs)("jobs: %j -> %d", (raw, expected) => {
    expect(parseCorrectionNumber(raw, "jobs")).toEqual({ ok: true, value: expected });
  });
});

describe("parseCorrectionNumber — invalid input", () => {
  type Bad = readonly [field: CorrectableKey, raw: string, error: string];

  const bad: Bad[] = [
    // Not a number at all.
    ["capacityOperationalMw", "", CAPACITY_ERROR],
    ["capacityOperationalMw", "   ", CAPACITY_ERROR],
    ["capacityOperationalMw", "abc", CAPACITY_ERROR],
    ["capacityOperationalMw", "NaN", CAPACITY_ERROR],
    ["capacityOperationalMw", "Infinity", CAPACITY_ERROR],
    ["capacityOperationalMw", "1e3", CAPACITY_ERROR],
    ["capacityOperationalMw", "1.2.3", CAPACITY_ERROR],
    ["capacityOperationalMw", "$$5", CAPACITY_ERROR],
    // The server needs a positive number; a minus sign isn't a number here.
    ["capacityOperationalMw", "-5", CAPACITY_ERROR],
    // Commas only where a thousands separator belongs: "1,5" must not become 15.
    ["capacityOperationalMw", "1,5", CAPACITY_ERROR],
    ["capacityOperationalMw", "1,2,3", CAPACITY_ERROR],
    ["capacityOperationalMw", "1,2000", CAPACITY_ERROR],
    ["capacityOperationalMw", "1 200", CAPACITY_ERROR],
    // Units capacity doesn't allow.
    ["capacityOperationalMw", "1.2M", CAPACITY_ERROR],
    ["capacityOperationalMw", "1.2 B", CAPACITY_ERROR],
    ["capacityOperationalMw", "2k", CAPACITY_ERROR],
    ["capacityOperationalMw", "5 million", CAPACITY_ERROR],
    ["capacityPlannedMw", "1.2M", CAPACITY_ERROR],
    // A unit must be one whole word, and inherited object keys are not units.
    ["capacityOperationalMw", "1.2 G W", CAPACITY_ERROR],
    ["capacityOperationalMw", "5 constructor", CAPACITY_ERROR],
    ["capacityOperationalMw", "5 __proto__", CAPACITY_ERROR],
    // Subsidies: dollar suffixes only.
    ["subsidies", "", SUBSIDY_ERROR],
    ["subsidies", "abc", SUBSIDY_ERROR],
    ["subsidies", "-1", SUBSIDY_ERROR],
    ["subsidies", "12.5 MW", SUBSIDY_ERROR],
    ["subsidies", "1.2 GW", SUBSIDY_ERROR],
    ["subsidies", "$12.5 xyz", SUBSIDY_ERROR],
    // Jobs: a whole number after scaling, and only the k suffix.
    ["jobs", "", JOBS_ERROR],
    ["jobs", "12.5", JOBS_ERROR],
    ["jobs", "1.2345k", JOBS_ERROR],
    ["jobs", "2m", JOBS_ERROR],
    ["jobs", "1.2 GW", JOBS_ERROR],
    ["jobs", "3 million", JOBS_ERROR],
    // Whole numbers the server's int() refuses: past Number.MAX_SAFE_INTEGER.
    ["jobs", `1${"0".repeat(300)}k`, JOBS_ERROR],
    ["jobs", "9,007,199,254,740,993", JOBS_ERROR],
    ["jobs", "9,007,199,254,741k", JOBS_ERROR],
  ];

  it.each(bad)("%s: %j is rejected with that field's message", (field, raw, error) => {
    expect(parseCorrectionNumber(raw, field)).toEqual({ ok: false, error });
  });

  // Zero is a number, so it isn't told to "enter a whole number"; the server
  // (validateFieldValue in lib/contribute.ts) refuses it for every number field.
  it.each([
    ["capacityOperationalMw", "0"],
    ["capacityOperationalMw", "0 GW"],
    ["capacityPlannedMw", "0.0"],
    ["subsidies", "0"],
    ["subsidies", "$0"],
    ["subsidies", "0M"],
    ["jobs", "0"],
    ["jobs", "0k"],
  ] as const)("%s: %j gets its own 'greater than 0' message", (field, raw) => {
    expect(parseCorrectionNumber(raw, field)).toEqual({ ok: false, error: ZERO_ERROR });
  });

  it("does not parse a field that isn't a number field", () => {
    expect(parseCorrectionNumber("5", "name")).toEqual({ ok: false, error: "Enter a number." });
  });
});

describe("correctionNumberHint", () => {
  it.each([
    ["capacityOperationalMw", "In megawatts. 1.2 GW works too."],
    ["capacityPlannedMw", "In megawatts. 1.2 GW works too."],
    ["subsidies", "In US dollars. 12.5M or 1.2B works too."],
    ["jobs", "Permanent jobs only."],
  ] as const)("%s", (field, hint) => {
    expect(correctionNumberHint(field)).toBe(hint);
  });

  it("is undefined for a field with no number input", () => {
    expect(correctionNumberHint("operator")).toBeUndefined();
  });
});

describe("normalizeSourceUrl", () => {
  it.each([
    ["example.com/a", "https://example.com/a"],
    ["  www.x.org  ", "https://www.x.org"],
    ["example.com", "https://example.com"],
  ])("adds https:// to a scheme-less link: %j -> %j", (raw, expected) => {
    expect(normalizeSourceUrl(raw)).toBe(expected);
  });

  it.each([
    ["//example.com", "https://example.com"],
    ["//example.com/a?b=1", "https://example.com/a?b=1"],
    ["///example.com", "https://example.com"],
    ["/example.com", "https://example.com"],
  ])("strips the leading slashes of %j: %j", (raw, expected) => {
    expect(normalizeSourceUrl(raw)).toBe(expected);
  });

  it.each([
    ["example.com:8080/a", "https://example.com:8080/a"],
    ["EXAMPLE.com:8080", "https://EXAMPLE.com:8080"],
    ["www.x.org:443?q=1", "https://www.x.org:443?q=1"],
    ["a.b:80#frag", "https://a.b:80#frag"],
  ])("treats %j as host:port, not a scheme: %j", (raw, expected) => {
    expect(normalizeSourceUrl(raw)).toBe(expected);
  });

  it.each([
    ["https://x.org/a"],
    ["http://x.org"],
    ["HTTPS://x.org"],
  ])("leaves %j alone: it already has a scheme", (raw) => {
    expect(normalizeSourceUrl(raw)).toBe(raw);
  });

  // The server (and isHttpUrl) must still get to reject these, so they are
  // returned as typed, never rewritten into a plausible-looking https link.
  it.each([
    ["javascript:alert(1)"],
    ["ftp://x.org/a"],
    ["data:text/html,hi"],
    ["mailto:a@b.com"],
    // A scheme followed by digits: only a dotted HOST before the colon counts
    // as host:port, so none of these may be rewritten into an https link.
    ["mailto:1@x.com"],
    ["javascript:0/a.b"],
    ["ftp:21/x.org"],
    // Would become a valid https URL if the scheme guard were missing.
    ["javascript://x.org/%0aalert(1)"],
    // Digits after the colon but then "@": without HOST_PORT_RE's trailing
    // [/?#]|$ check this would become https://example.com:8080@evil.com/,
    // whose host is evil.com.
    ["example.com:8080@evil.com/"],
  ])("leaves the non-http scheme %j as is", (raw) => {
    expect(normalizeSourceUrl(raw)).toBe(raw);
  });

  it.each([
    ["not a url"],
    ["nodots"],
    ["example.com/a b"], // a dot, but whitespace: not a link
    ["example.com:8080/a b"], // host:port, but whitespace: not a link
  ])("leaves %j alone: it doesn't look like a link", (raw) => {
    expect(normalizeSourceUrl(raw)).toBe(raw);
  });

  it("does not turn a user:password@host trick into an https link", () => {
    const normalized = normalizeSourceUrl("example.com:8080@evil.com/");
    expect(normalized).toBe("example.com:8080@evil.com/");
    expect(isHttpUrl(normalized)).toBe(false);
  });

  it("returns an empty or blank input as empty", () => {
    expect(normalizeSourceUrl("")).toBe("");
    expect(normalizeSourceUrl("   ")).toBe("");
  });

});

describe("isHttpUrl", () => {
  it.each(["https://x.org", "http://x.org/a?b=1", "HTTPS://X.ORG"])("accepts %j", (value) => {
    expect(isHttpUrl(value)).toBe(true);
  });

  it.each([
    "ftp://x.org",
    "javascript:alert(1)",
    "javascript://x.org/%0aalert(1)",
    "example.com:8080@evil.com/",
    "data:text/html,hi",
    "x.org",
    "",
    "https://",
    "not a url",
  ])(
    "rejects %j",
    (value) => {
      expect(isHttpUrl(value)).toBe(false);
    }
  );
});
