// @vitest-environment node
import { describe, expect, it } from "vitest";

import { dayAwareStaleHours, MON_FRI } from "./schedule-budget";

const NY = { timeZone: "America/New_York", weekdays: MON_FRI };

// 2026-11-16 is a Monday. Noon New York (EST, UTC-5) = 17:00Z.
const day = (d: number) => new Date(`2026-11-${String(d).padStart(2, "0")}T17:00:00Z`);

describe("dayAwareStaleHours", () => {
  it("Mon-Fri in New York: Mon 84, Tue-Sat 36, Sun 60", () => {
    const got = [16, 17, 18, 19, 20, 21, 22].map((d) => dayAwareStaleHours(day(d), NY));
    expect(got).toEqual([84, 36, 36, 36, 36, 36, 60]);
  });

  it("uses the schedule's zone, not UTC: Mon 22:00 New York is already Tue in UTC", () => {
    const now = new Date("2026-11-17T03:00:00Z");
    expect(dayAwareStaleHours(now, NY)).toBe(84);
    expect(dayAwareStaleHours(now, { timeZone: "UTC", weekdays: MON_FRI })).toBe(36);
  });

  it("is unaffected by the DST change (2026-11-01)", () => {
    // Sun 11-01 (fall back), Mon 11-02, Tue 11-03, noon New York each day.
    expect(dayAwareStaleHours(new Date("2026-11-01T17:00:00Z"), NY)).toBe(60);
    expect(dayAwareStaleHours(new Date("2026-11-02T17:00:00Z"), NY)).toBe(84);
    expect(dayAwareStaleHours(new Date("2026-11-03T17:00:00Z"), NY)).toBe(36);
    // Just after midnight local on the changeover day itself.
    expect(dayAwareStaleHours(new Date("2026-11-01T04:30:00Z"), NY)).toBe(60);
  });

  it("Mon/Wed/Fri schedule: Mon 84, Tue 36, Wed 60, Thu 36, Fri 60, Sat 36, Sun 60", () => {
    const mwf = { timeZone: "America/New_York", weekdays: [1, 3, 5] };
    const got = [16, 17, 18, 19, 20, 21, 22].map((d) => dayAwareStaleHours(day(d), mwf));
    expect(got).toEqual([84, 36, 60, 36, 60, 36, 60]);
  });

  it("honours a custom slack", () => {
    expect(dayAwareStaleHours(day(17), { ...NY, slackHours: 0 })).toBe(24);
  });

  it("a single-day schedule wraps a full week", () => {
    expect(dayAwareStaleHours(day(16), { timeZone: "UTC", weekdays: [1] })).toBe(7 * 24 + 12);
  });

  it("throws on an empty weekday list", () => {
    expect(() => dayAwareStaleHours(day(16), { timeZone: "UTC", weekdays: [] })).toThrow(/empty/);
  });

  it("throws on out-of-range weekdays", () => {
    expect(() => dayAwareStaleHours(day(16), { timeZone: "UTC", weekdays: [0] })).toThrow(/outside/);
    expect(() => dayAwareStaleHours(day(16), { timeZone: "UTC", weekdays: [8] })).toThrow(/outside/);
    expect(() => dayAwareStaleHours(day(16), { timeZone: "UTC", weekdays: [1.5] })).toThrow(/outside/);
  });
});
