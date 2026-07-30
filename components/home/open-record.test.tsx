import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { OpenRecord } from "./open-record";
import type { ActivityEntry } from "@/lib/data";

// next/link renders to <a> — mock to avoid Next.js router-context dependency
// in jsdom (same pattern as app/activity/activity-list.test.tsx; OpenRecord
// both uses next/link directly and renders ActivityList, which also does).
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

const recentActivity: ActivityEntry[] = [
  {
    kind: "update",
    facilityId: "facility-a",
    facilityName: "Facility A",
    label: "facility updated",
    timestamp: new Date("2026-07-12T00:00:00Z"),
  },
  {
    kind: "create",
    facilityId: "facility-c",
    facilityName: "Facility C",
    label: "new facility added",
    timestamp: new Date("2026-07-11T00:00:00Z"),
  },
];

describe("OpenRecord", () => {
  it("renders the formatted sources-cited count", () => {
    render(<OpenRecord sources={2570} recentActivity={[]} />);
    expect(screen.getByText("2,570")).toBeInTheDocument();
  });

  it("renders all four provenance fact labels and values", () => {
    render(<OpenRecord sources={100} recentActivity={[]} />);
    expect(screen.getByText("Sources cited")).toBeInTheDocument();
    expect(screen.getByText("Moderation")).toBeInTheDocument();
    expect(screen.getByText("Human-gated")).toBeInTheDocument();
    expect(screen.getByText("License")).toBeInTheDocument();
    expect(screen.getByText("Open data")).toBeInTheDocument();
    expect(screen.getByText("Access")).toBeInTheDocument();
    expect(screen.getByText("API + RSS")).toBeInTheDocument();
  });

  it("links the contribute CTA to /contribute", () => {
    render(<OpenRecord sources={100} recentActivity={[]} />);
    expect(
      screen.getByRole("link", { name: /Add a facility/i })
    ).toHaveAttribute("href", "/contribute");
  });

  it("links the JSON API and RSS feed access facts", () => {
    render(<OpenRecord sources={100} recentActivity={[]} />);
    expect(screen.getByRole("link", { name: "JSON API" })).toHaveAttribute(
      "href",
      "/api"
    );
    expect(screen.getByRole("link", { name: "RSS feed" })).toHaveAttribute(
      "href",
      "/activity/feed.xml"
    );
  });

  it("renders the recent-activity stream when entries are present", () => {
    render(<OpenRecord sources={100} recentActivity={recentActivity} />);
    expect(
      screen.getByRole("heading", { name: "Recently updated" })
    ).toBeInTheDocument();
    expect(screen.getByText("Facility A")).toBeInTheDocument();
    expect(screen.getByText("Facility C")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View all/i })).toHaveAttribute(
      "href",
      "/activity"
    );
  });

  it("omits the recent-activity stream but still renders facts and CTA when empty", () => {
    render(<OpenRecord sources={100} recentActivity={[]} />);
    expect(
      screen.queryByRole("heading", { name: "Recently updated" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /View all/i })).not.toBeInTheDocument();
    expect(screen.getByText("Sources cited")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Add a facility/i })
    ).toBeInTheDocument();
  });
});
