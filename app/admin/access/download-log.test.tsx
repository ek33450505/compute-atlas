import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { DownloadLog } from "./download-log";
import type { AdminDatasetDownloadLog } from "@/lib/dataset-admin";

function makeLog(overrides: Partial<AdminDatasetDownloadLog> = {}): AdminDatasetDownloadLog {
  return {
    grant: {
      id: "g1",
      name: "Ada Lovelace",
      email: "ada@example.org",
      status: "active",
      downloadCount: 7,
      lastDownloadAt: new Date("2026-11-03T09:30:00Z"),
    },
    downloads: [
      {
        id: "d2",
        createdAt: new Date("2026-11-03T09:30:00Z"),
        file: "facilities.csv",
        outcome: "served",
        editionId: "abcdef12-3456-7890",
      },
      {
        id: "d1",
        createdAt: new Date("2026-11-02T08:00:00Z"),
        file: "facilities.json",
        outcome: "denied_rate",
        editionId: null,
      },
    ],
    ...overrides,
  };
}

describe("DownloadLog", () => {
  it("shows the grant summary", () => {
    render(<DownloadLog log={makeLog()} />);

    expect(screen.getByRole("heading", { level: 2, name: "Download log: Ada Lovelace" })).toBeInTheDocument();
    expect(screen.getByText("ada@example.org")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    const last = screen.getAllByText("2026-11-03 09:30:00 UTC")[0];
    expect(last.closest("time")).toHaveAttribute("datetime", "2026-11-03T09:30:00.000Z");
  });

  it("lists downloads in the order given, with a caption and short edition id", () => {
    render(<DownloadLog log={makeLog()} />);

    const table = screen.getByRole("table", { name: /newest 50 entries at most/i });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText("facilities.csv")).toBeInTheDocument();
    expect(within(rows[1]).getByText("served")).toBeInTheDocument();
    expect(within(rows[1]).getByText("abcdef12")).toHaveAttribute("title", "abcdef12-3456-7890");
    expect(within(rows[2]).getByText("facilities.json")).toBeInTheDocument();
    expect(within(rows[2]).getByText("denied_rate")).toBeInTheDocument();
    expect(within(table).getAllByRole("columnheader")).toHaveLength(4);
  });

  it("puts the full edition id in the text for assistive tech, not only in a title", () => {
    render(<DownloadLog log={makeLog()} />);

    const cell = within(screen.getAllByRole("row")[1]).getByText("abcdef12").closest("td");
    expect(cell).toHaveTextContent("abcdef12-3456-7890");
    expect(within(cell as HTMLElement).getByText("abcdef12-3456-7890")).toHaveClass("sr-only");
  });

  it("makes the heading focusable and moves focus to it on mount", () => {
    render(<DownloadLog log={makeLog()} />);

    const heading = screen.getByRole("heading", { level: 2, name: /Download log: Ada Lovelace/ });
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(heading).toHaveFocus();
  });

  it("does the same for an unknown grant", () => {
    render(<DownloadLog log={null} />);

    expect(screen.getByRole("heading", { level: 2, name: "Download log" })).toHaveFocus();
  });

  it("shows an empty state and 'Never' with no downloads", () => {
    render(
      <DownloadLog
        log={makeLog({
          downloads: [],
          grant: { ...makeLog().grant, downloadCount: 0, lastDownloadAt: null },
        })}
      />
    );

    expect(screen.getByText("No downloads recorded.")).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("says so for an unknown grant", () => {
    render(<DownloadLog log={null} />);

    expect(screen.getByText("No such grant.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders a close link only when given a href", () => {
    const { rerender } = render(<DownloadLog log={makeLog()} />);
    expect(screen.queryByRole("link", { name: "Close log" })).toBeNull();

    rerender(<DownloadLog log={makeLog()} closeHref="/admin/access?status=active" />);
    expect(screen.getByRole("link", { name: "Close log" })).toHaveAttribute(
      "href",
      "/admin/access?status=active"
    );
  });

  it("renders hostile values as text, not markup", () => {
    const xss = '<img src=x onerror="alert(1)">';
    const base = makeLog();
    const { container } = render(
      <DownloadLog
        log={makeLog({
          grant: { ...base.grant, name: xss },
          downloads: [{ ...base.downloads[0], file: xss }],
        })}
      />
    );

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByText(xss).length).toBeGreaterThan(0);
  });
});
