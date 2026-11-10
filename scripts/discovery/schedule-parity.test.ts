// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { MONITORED_WORKFLOWS } from "../automation-health";
import {
  DISCOVERY_LONG_BUDGET_ISO_WEEKDAYS,
  DISCOVERY_STALE_HOURS_DEFAULT,
  DISCOVERY_STALE_HOURS_WEEKDAY,
} from "./check-heartbeat";

// The discovery schedule lives in four places that nothing else ties together:
// the launchd plist, the watchdog workflow's cron, run.sh's local stale check,
// and the remote stale thresholds. This pins them to each other.

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

const plist = read("scripts/discovery/com.compute-atlas.discovery.plist");
const workflow = read(".github/workflows/discovery-watchdog.yml");
const runSh = read("scripts/discovery/run.sh");

function workflowCron(): { cron: string; days: Set<number> } {
  const lines = workflow.match(/^\s*-\s*cron:\s*"([^"]+)"/gm) ?? [];
  expect(lines).toHaveLength(1);
  const cron = /"([^"]+)"/.exec(lines[0]!)![1]!;
  const fields = cron.split(/\s+/);
  expect(fields).toHaveLength(5);
  const days = fields[4]!.split(",").map((d) => Number(d));
  days.forEach((d) => expect(Number.isInteger(d)).toBe(true));
  return { cron, days: new Set(days) };
}

describe("discovery schedule parity", () => {
  it("plist StartCalendarInterval weekdays equal the watchdog cron's days, at 13:00", () => {
    const start = plist.indexOf("<key>StartCalendarInterval</key>");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = plist.indexOf("</array>", start);
    expect(end).toBeGreaterThan(start);
    const block = plist.slice(start, end);

    const dicts = block.match(/<dict>[\s\S]*?<\/dict>/g) ?? [];
    expect(dicts).toHaveLength(5);

    const weekdays = new Set<number>();
    for (const dict of dicts) {
      const weekday = dict.match(/<key>Weekday<\/key>\s*<integer>(\d+)<\/integer>/g) ?? [];
      const hour = dict.match(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/g) ?? [];
      const minute = dict.match(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/g) ?? [];
      expect(weekday).toHaveLength(1);
      expect(hour).toHaveLength(1);
      expect(minute).toHaveLength(1);
      expect(hour[0]).toMatch(/<integer>13<\/integer>$/);
      expect(minute[0]).toMatch(/<integer>0<\/integer>$/);
      weekdays.add(Number(/<integer>(\d+)<\/integer>/.exec(weekday[0]!)![1]));
    }
    expect(weekdays.size).toBe(5);
    expect(weekdays).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(weekdays).toEqual(workflowCron().days);
  });

  it("run.sh's day-aware DISCOVERY_STALE_HOURS literals equal check-heartbeat's", () => {
    const monday = [...runSh.matchAll(/^\s*1\|6\|7\) DISCOVERY_STALE_HOURS=(\d+)/gm)];
    const weekday = [...runSh.matchAll(/^\s*\*\) DISCOVERY_STALE_HOURS=(\d+)/gm)];
    expect(monday).toHaveLength(1);
    expect(weekday).toHaveLength(1);
    expect(Number(monday[0]![1])).toBe(DISCOVERY_STALE_HOURS_DEFAULT);
    expect(Number(weekday[0]![1])).toBe(DISCOVERY_STALE_HOURS_WEEKDAY);
  });

  it("run.sh's long-budget case arm covers the same weekdays as check-heartbeat's", () => {
    const arms = [...runSh.matchAll(/^\s*([0-9|]+)\) DISCOVERY_STALE_HOURS=/gm)];
    expect(arms).toHaveLength(1);
    const days = arms[0]![1]!.split("|").map(Number);
    expect(new Set(days)).toEqual(new Set(DISCOVERY_LONG_BUDGET_ISO_WEEKDAYS));
  });

  // Monday: > 72 (normal Fri -> Mon gap, ~70h end to start) and < 93 (the
  // shortest gap a single missed Friday leaves, Thu end -> Mon).
  it("Monday/weekend budget sits between the normal Fri->Mon gap and a single missed Friday", () => {
    expect(DISCOVERY_STALE_HOURS_DEFAULT).toBeGreaterThan(72);
    expect(DISCOVERY_STALE_HOURS_DEFAULT).toBeLessThan(93);
  });

  // Tue-Fri: > 24 (normal ~22h gap) and < 45 (a single missed midweek run).
  it("weekday budget sits between the normal daily gap and a single missed midweek run", () => {
    expect(DISCOVERY_STALE_HOURS_WEEKDAY).toBeGreaterThan(24);
    expect(DISCOVERY_STALE_HOURS_WEEKDAY).toBeLessThan(45);
  });

  it("automation-health's discovery-watchdog entry matches the workflow cron and stale default", () => {
    const entries = MONITORED_WORKFLOWS.filter((w) => w.file === "discovery-watchdog.yml");
    expect(entries).toHaveLength(1);
    expect(entries[0].staleAfterHours).toBe(DISCOVERY_STALE_HOURS_DEFAULT);
    expect(entries[0].cronDescription.startsWith(workflowCron().cron)).toBe(true);
  });
});
