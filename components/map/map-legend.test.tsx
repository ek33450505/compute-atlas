import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MapLegend } from "./map-legend";

describe("MapLegend", () => {
  it("renders all 5 status labels", () => {
    render(<MapLegend />);
    expect(screen.getByText("Operational")).toBeInTheDocument();
    expect(screen.getByText("Under construction")).toBeInTheDocument();
    expect(screen.getByText("Permitted")).toBeInTheDocument();
    expect(screen.getByText("Proposed")).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("has an accessible region name", () => {
    render(<MapLegend />);
    expect(
      screen.getByRole("region", { name: /map legend/i })
    ).toBeInTheDocument();
  });

  it("renders all facility-type labels", () => {
    render(<MapLegend />);
    expect(screen.getByText("Data center")).toBeInTheDocument();
    expect(screen.getByText("Crypto mining")).toBeInTheDocument();
    expect(screen.getByText("Power generation")).toBeInTheDocument();
  });
});
