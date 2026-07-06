import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusTimeline } from "./status-timeline";
import type { StatusEvent, Source } from "@/lib/schema";

const SOURCES: Source[] = [
  {
    url: "https://example.com/source-1",
    label: "Example Source One",
    publisher: "Example Publisher",
    retrievedAt: "2026-01-01",
    kind: "press",
  },
  {
    url: "https://example.com/source-2",
    label: "Example Source Two",
    retrievedAt: "2026-02-01",
    kind: "permit",
  },
];

const HISTORY: StatusEvent[] = [
  {
    status: "proposed",
    date: "2024-01",
    note: "Initial announcement made.",
    sourceIndex: 0,
  },
  {
    status: "under_construction",
    date: "2024-06",
    note: "Construction started.",
    sourceIndex: 1,
  },
  {
    status: "operational",
    date: "2024-12",
    // no note, no sourceIndex
  },
];

describe("StatusTimeline", () => {
  it("renders the list as an <ol> (list role)", () => {
    render(<StatusTimeline history={HISTORY} sources={SOURCES} />);
    expect(screen.getByRole("list")).toBeInTheDocument();
  });

  it("renders one listitem per history event", () => {
    render(<StatusTimeline history={HISTORY} sources={SOURCES} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(HISTORY.length);
  });

  it("renders the status label for each event", () => {
    render(<StatusTimeline history={HISTORY} sources={SOURCES} />);
    expect(screen.getByText("Proposed")).toBeInTheDocument();
    expect(screen.getByText("Under construction")).toBeInTheDocument();
    expect(screen.getByText("Operational")).toBeInTheDocument();
  });

  it("renders the date for each event", () => {
    render(<StatusTimeline history={HISTORY} sources={SOURCES} />);
    expect(screen.getByText("2024-01")).toBeInTheDocument();
    expect(screen.getByText("2024-06")).toBeInTheDocument();
    expect(screen.getByText("2024-12")).toBeInTheDocument();
  });

  it("renders event notes when present", () => {
    render(<StatusTimeline history={HISTORY} sources={SOURCES} />);
    expect(screen.getByText("Initial announcement made.")).toBeInTheDocument();
    expect(screen.getByText("Construction started.")).toBeInTheDocument();
  });

  it("renders an external source link when sourceIndex is set and valid", () => {
    render(<StatusTimeline history={HISTORY} sources={SOURCES} />);
    const link = screen.getByRole("link", {
      name: /Example Source One \(opens in new tab\)/i,
    });
    expect(link).toHaveAttribute("href", "https://example.com/source-1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("renders the second source link correctly", () => {
    render(<StatusTimeline history={HISTORY} sources={SOURCES} />);
    const link = screen.getByRole("link", {
      name: /Example Source Two \(opens in new tab\)/i,
    });
    expect(link).toHaveAttribute("href", "https://example.com/source-2");
  });

  it("does not render a source link when sourceIndex is undefined", () => {
    render(<StatusTimeline history={HISTORY} sources={SOURCES} />);
    // Third event has no sourceIndex — only 2 source links should exist
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
  });

  it("renders the empty-history message when history is empty", () => {
    render(<StatusTimeline history={[]} sources={SOURCES} />);
    expect(
      screen.getByText("No recorded status history yet.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
