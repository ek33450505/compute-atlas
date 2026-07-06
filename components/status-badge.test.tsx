import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./status-badge";

describe("StatusBadge", () => {
  it("renders the text label for operational (status is not color-only)", () => {
    render(<StatusBadge status="operational" />);
    expect(screen.getByText("Operational")).toBeInTheDocument();
  });

  it("renders the text label for under_construction", () => {
    render(<StatusBadge status="under_construction" />);
    expect(screen.getByText("Under construction")).toBeInTheDocument();
  });

  it("renders the icon as aria-hidden", () => {
    const { container } = render(<StatusBadge status="operational" />);
    const icon = container.querySelector("[aria-hidden='true']");
    expect(icon).toBeInTheDocument();
  });
});
