import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { ThisWeek, isActivityWindowTruncated } from "./this-week";
import type { ActivityEntry } from "@/lib/data";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const now = new Date("2026-11-09T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function entry(kind: "create" | "update", id: string, ageMs: number): ActivityEntry {
  return {
    kind,
    facilityId: id,
    facilityName: `Site ${id}`,
    label: kind === "create" ? "new facility added" : "facility updated",
    timestamp: new Date(now.getTime() - ageMs),
  };
}

describe("ThisWeek", () => {
  it("says so plainly, and still links to /activity, when there are no entries", () => {
    render(<ThisWeek entries={[]} now={now} truncated={false} />);
    expect(screen.getByRole("heading", { name: "Last 7 days" })).toBeInTheDocument();
    expect(screen.getByText("The 7 days to 9 November 2026. No changes to the records in that window.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /All activity/ })).toHaveAttribute("href", "/activity");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("shows the quiet-week line when every entry is older than 7 days", () => {
    render(<ThisWeek entries={[entry("create", "a", 7 * DAY + 1)]} now={now} truncated={false} />);
    expect(screen.getByText("The 7 days to 9 November 2026. No changes to the records in that window.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Site a" })).toBeNull();
  });

  it("includes an entry exactly 7 days old and drops one just past it", () => {
    render(
      <ThisWeek
        entries={[entry("create", "a", 7 * DAY), entry("create", "b", 7 * DAY + 1)]}
        now={now}
        truncated={false}
      />
    );
    expect(screen.getByText(/1 site added/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Site a" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Site b" })).toBeNull();
  });

  it("counts creates and updates with correct pluralization", () => {
    render(
      <ThisWeek
        entries={[
          entry("create", "a", DAY),
          entry("create", "b", 2 * DAY),
          entry("update", "c", 3 * DAY),
        ]}
        now={now}
        truncated={false}
      />
    );
    expect(screen.getByText("2 sites added · 1 record updated")).toBeInTheDocument();
  });

  it("shows N+ when truncated", () => {
    render(
      <ThisWeek
        entries={[entry("create", "a", DAY), entry("update", "b", DAY), entry("update", "c", DAY)]}
        now={now}
        truncated
      />
    );
    expect(screen.getByText("1+ sites added · 2+ records updated")).toBeInTheDocument();
  });

  it("lists at most 7 entries linking to facility pages, plus the activity link", () => {
    const entries = ["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((id, i) =>
      entry("update", id, (i + 1) * 1000)
    );
    render(<ThisWeek entries={entries} now={now} truncated={false} />);
    expect(screen.getByRole("link", { name: "Site a" })).toHaveAttribute("href", "/facilities/a");
    expect(screen.getByRole("link", { name: "Site g" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Site h" })).toBeNull();
    expect(screen.getByRole("link", { name: /All activity/ })).toHaveAttribute("href", "/activity");
    expect(screen.getByRole("heading", { name: "Last 7 days" })).toBeInTheDocument();
  });

  it("shows what changed, where, the date and the CURRENT status (captioned Now) on each row", () => {
    render(
      <ThisWeek
        entries={[entry("update", "a", DAY), entry("create", "b", 2 * DAY)]}
        now={now}
        truncated={false}
        places={{ a: { status: "under_construction", state: "TX" } }}
      />
    );
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Site a");
    expect(rows[0]).toHaveTextContent("facility updated · Texas · Nov 8");
    expect(within(rows[0]).getByText("Now:")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Under construction")).toBeInTheDocument();
    // No place data for b: the row still renders, without a badge or state.
    expect(rows[1]).toHaveTextContent("new facility added · Nov 7");
    expect(rows[1]).not.toHaveTextContent("Texas");
  });

  it("dates the window's end so a cached render cannot overclaim", () => {
    render(<ThisWeek entries={[entry("update", "a", DAY)]} now={now} truncated={false} />);
    expect(screen.getByText(/The 7 days to 9 November 2026\./)).toBeInTheDocument();
  });

  it("omits a zero part instead of rendering 0 sites added", () => {
    render(<ThisWeek entries={[entry("update", "a", DAY)]} now={now} truncated />);
    expect(screen.getByText("1+ records updated")).toBeInTheDocument();
    expect(screen.queryByText(/sites added/)).toBeNull();
  });
});

describe("isActivityWindowTruncated", () => {
  const rows = (n: number, ageMs: number) =>
    Array.from({ length: n }, (_, i) => entry("update", String(i), ageMs));

  it("is false for an empty list", () => {
    expect(isActivityWindowTruncated([], 3, now)).toBe(false);
  });
  it("is false under the limit", () => {
    expect(isActivityWindowTruncated(rows(2, DAY), 3, now)).toBe(false);
  });
  it("is true at the limit with the oldest inside the window", () => {
    expect(isActivityWindowTruncated(rows(3, DAY), 3, now)).toBe(true);
  });
  it("is true at the limit with the oldest exactly 7 days old (inclusive boundary, same as ThisWeek's filter)", () => {
    expect(isActivityWindowTruncated(rows(3, 7 * DAY), 3, now)).toBe(true);
  });
  it("is false at the limit with the oldest outside the window", () => {
    expect(isActivityWindowTruncated(rows(3, 8 * DAY), 3, now)).toBe(false);
  });
});
