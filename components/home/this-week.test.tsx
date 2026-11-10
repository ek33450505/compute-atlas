import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

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
  it("renders nothing when there are no entries", () => {
    const { container } = render(<ThisWeek entries={[]} now={now} truncated={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when every entry is older than 7 days", () => {
    const { container } = render(
      <ThisWeek entries={[entry("create", "a", 7 * DAY + 1)]} now={now} truncated={false} />
    );
    expect(container).toBeEmptyDOMElement();
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

  it("lists at most 3 entries linking to facility pages, plus the activity link", () => {
    const entries = ["a", "b", "c", "d", "e"].map((id, i) => entry("update", id, (i + 1) * 1000));
    render(<ThisWeek entries={entries} now={now} truncated={false} />);
    expect(screen.getByRole("link", { name: "Site a" })).toHaveAttribute("href", "/facilities/a");
    expect(screen.getByRole("link", { name: "Site c" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Site d" })).toBeNull();
    expect(screen.getByRole("link", { name: /All activity/ })).toHaveAttribute("href", "/activity");
    expect(screen.getByRole("heading", { name: "Last 7 days" })).toBeInTheDocument();
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
