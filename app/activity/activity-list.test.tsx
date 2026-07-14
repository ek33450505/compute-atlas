import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { ActivityList } from "./activity-list";
import type { ActivityEntry } from "@/lib/data";

// next/link renders to <a> — mock to avoid Next.js router-context dependency in jsdom
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

const entries: ActivityEntry[] = [
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

describe("ActivityList", () => {
  it("renders each entry's facility name, label, and timestamp", () => {
    render(<ActivityList entries={entries} />);
    expect(screen.getByText("Facility A")).toBeInTheDocument();
    expect(screen.getByText("facility updated")).toBeInTheDocument();
    expect(screen.getByText("Facility C")).toBeInTheDocument();
    expect(screen.getByText("new facility added")).toBeInTheDocument();
  });

  it("links each facility name to its detail page", () => {
    render(<ActivityList entries={entries} />);
    expect(screen.getByRole("link", { name: "Facility A" })).toHaveAttribute(
      "href",
      "/facilities/facility-a"
    );
    expect(screen.getByRole("link", { name: "Facility C" })).toHaveAttribute(
      "href",
      "/facilities/facility-c"
    );
  });

  it("renders a fallback message when there are no entries", () => {
    render(<ActivityList entries={[]} />);
    expect(screen.getByText(/no recent activity/i)).toBeInTheDocument();
  });

  it("does not render a link when facilityId is empty", () => {
    const withoutId: ActivityEntry[] = [
      {
        kind: "create",
        facilityId: "",
        facilityName: "Unknown facility",
        label: "new facility added",
        timestamp: new Date("2026-07-10T00:00:00Z"),
      },
    ];
    render(<ActivityList entries={withoutId} />);
    expect(screen.getByText("Unknown facility")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
