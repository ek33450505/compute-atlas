import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusLegend } from "./status-legend";

describe("StatusLegend", () => {
  it("renders all 5 status labels", () => {
    render(<StatusLegend />);
    expect(
      screen.getByText("Operational")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Under construction")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Permitted")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Proposed")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Cancelled")
    ).toBeInTheDocument();
  });

  it("renders each status description (non-color encoding)", () => {
    render(<StatusLegend />);
    expect(screen.getByText("Built and running.")).toBeInTheDocument();
    expect(screen.getByText("Actively being built.")).toBeInTheDocument();
    expect(
      screen.getByText("Approved/permitted, not yet under construction.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Announced or proposed; not yet approved.")
    ).toBeInTheDocument();
    expect(screen.getByText("Cancelled or withdrawn.")).toBeInTheDocument();
  });

  it("renders a titled region for the legend", () => {
    render(<StatusLegend />);
    expect(screen.getByText("Build status")).toBeInTheDocument();
  });

  it("renders a list of status items", () => {
    render(<StatusLegend />);
    const list = screen.getByRole("list");
    expect(list).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(5);
  });
});
