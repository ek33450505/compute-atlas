// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { MONITORED_WORKFLOWS } from "../automation-health";
import { DISCOVERY_SCHEDULE } from "./check-heartbeat";
import { dayAwareStaleHours } from "../schedule-budget";

// The discovery schedule lives in four places that nothing else ties together:
// the launchd plist, the watchdog workflow's cron, run.sh's local stale check,
// and the remote stale thresholds. This pins them to each other.

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

const plist = read("scripts/discovery/com.compute-atlas.discovery.plist");
const workflow = read(".github/workflows/discovery-watchdog.yml");
const runSh = read("scripts/discovery/run.sh");

// Expands a cron day-of-week field: comma lists and "a-b" ranges ("1,3,5", "1-5").
export function parseCronDays(field: string): Set<number> {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      expect(lo).toBeLessThanOrEqual(hi);
      for (let d = lo; d <= hi; d++) days.add(d);
    } else {
      expect(part).toMatch(/^\d+$/);
      days.add(Number(part));
    }
  }
  return days;
}

// Returns a list of structural problems in the plist text (empty = fine).
export function plistStructureProblems(text: string): string[] {
  const problems: string[] = [];
  const startKey = "<key>StartCalendarInterval</key>";
  const starts = text.split(startKey).length - 1;
  if (starts !== 1) problems.push(`expected 1 StartCalendarInterval key, found ${starts}`);

  const pa = text.indexOf("<key>ProgramArguments</key>");
  const open = pa < 0 ? -1 : text.indexOf("<array>", pa);
  const close = open < 0 ? -1 : text.indexOf("</array>", open);
  if (close < 0) return [...problems, "ProgramArguments array not found"];
  const body = text.slice(open + "<array>".length, close);
  if (/<dict>|<key>/.test(body)) problems.push("ProgramArguments contains a <dict> or <key>");
  const strings = [...body.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  if (JSON.stringify(strings) !== JSON.stringify(["/bin/bash", "__REPO_PATH__/scripts/discovery/run.sh"])) {
    problems.push(`ProgramArguments strings were ${JSON.stringify(strings)}`);
  }

  const start = text.indexOf(startKey);
  if (start >= 0) {
    const firstWeekday = text.indexOf("<key>Weekday</key>");
    const lastWeekday = text.lastIndexOf("<key>Weekday</key>");
    if (firstWeekday < start || lastWeekday < start) problems.push("a Weekday key appears before StartCalendarInterval");
  }
  return problems;
}

function workflowCron(): { cron: string; days: Set<number> } {
  const lines = workflow.match(/^\s*-\s*cron:\s*"([^"]+)"/gm) ?? [];
  expect(lines).toHaveLength(1);
  const cron = /"([^"]+)"/.exec(lines[0]!)![1]!;
  const fields = cron.split(/\s+/);
  expect(fields).toHaveLength(5);
  return { cron, days: parseCronDays(fields[4]!) };
}

describe("discovery schedule parity", () => {
  it("parseCronDays expands lists and ranges", () => {
    expect(parseCronDays("1-5")).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(parseCronDays("1,3,5")).toEqual(new Set([1, 3, 5]));
    expect(parseCronDays("1-2,5")).toEqual(new Set([1, 2, 5]));
  });

  it("plist ProgramArguments is exactly bash + run.sh, with Weekday dicts only under StartCalendarInterval", () => {
    expect(plistStructureProblems(plist)).toEqual([]);
  });

  it("plistStructureProblems flags a <dict> injected into ProgramArguments (mutation check)", () => {
    const mutated = plist.replace(
      "<array>",
      "<array>\n<dict><key>Weekday</key><integer>1</integer></dict>",
    );
    const problems = plistStructureProblems(mutated);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toMatch(/ProgramArguments contains/);
    expect(problems.join(" ")).toMatch(/Weekday key appears before/);
    expect(plistStructureProblems(plist + "\n" + "<key>StartCalendarInterval</key>")).toEqual([
      "expected 1 StartCalendarInterval key, found 2",
    ]);
  });

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
    expect(weekdays).toEqual(workflowCron().days);
  });

  // NEGATIVE proxy only. The real run.sh-vs-TS table parity is the BATS test
  // "the day-aware budget table is 84/36/36/36/36/36/60 for Mon..Sun" in
  // tests/discovery/run.bats, paired with scripts/schedule-budget.test.ts.
  it("run.sh carries no flat DISCOVERY_STALE_HOURS default (its budget is day-aware)", () => {
    expect(runSh).not.toMatch(/DISCOVERY_STALE_HOURS:-\d+/);
  });

  // Longest normal gap is Fri -> Mon (~70h end to start): Monday's budget must
  // sit above it, else a normal Monday warns; a single missed weekday must not
  // fit inside any other day's budget.
  it("day-aware budget: Monday clears the Fri -> Mon gap, other days flag one missed run", () => {
    const at = (d: number) => new Date(`2026-11-${d}T17:00:00Z`); // noon New York, Mon 16 .. Sun 22
    expect(dayAwareStaleHours(at(16), DISCOVERY_SCHEDULE)).toBeGreaterThan(72);
    expect(dayAwareStaleHours(at(16), DISCOVERY_SCHEDULE)).toBeLessThan(88);
    for (const d of [17, 18, 19, 20]) {
      expect(dayAwareStaleHours(at(d), DISCOVERY_SCHEDULE)).toBeLessThan(48);
    }
  });

  it("automation-health's discovery-watchdog entry matches the workflow cron and flat 84h budget", () => {
    const entries = MONITORED_WORKFLOWS.filter((w) => w.file === "discovery-watchdog.yml");
    expect(entries).toHaveLength(1);
    expect(entries[0].staleAfterHours).toBe(84); // flat: it monitors GitHub's scheduler, runs land a day late
    expect(entries[0].cronDescription.startsWith(workflowCron().cron)).toBe(true);
  });
});
