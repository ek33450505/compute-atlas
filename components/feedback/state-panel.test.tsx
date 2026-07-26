import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatePanel } from "./state-panel";

describe("StatePanel", () => {
  it("renders the title as an h1 when titleAs='h1'", () => {
    render(<StatePanel titleAs="h1" title="Off the edge of the map" />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Off the edge of the map" })
    ).toBeInTheDocument();
  });

  it("renders the title as an h2 by default", () => {
    render(<StatePanel title="No facilities match these filters" />);
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "No facilities match these filters",
      })
    ).toBeInTheDocument();
  });

  it("renders eyebrow, description, and actions when provided", () => {
    render(
      <StatePanel
        eyebrow="404"
        title="Off the edge of the map"
        description="This page isn't on the atlas."
        actions={<button type="button">Back to the map</button>}
      />
    );
    expect(screen.getByText("404")).toBeInTheDocument();
    expect(
      screen.getByText("This page isn't on the atlas.")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to the map" })
    ).toBeInTheDocument();
  });

  it("omits the actions container when actions is absent", () => {
    const { container } = render(<StatePanel title="No results" />);
    expect(container.querySelectorAll("button, a")).toHaveLength(0);
  });

  it("renders no heading when titleAs='p'", () => {
    render(
      <StatePanel titleAs="p" title="No facilities match these filters" />
    );
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(
      screen.getByText("No facilities match these filters")
    ).toBeInTheDocument();
  });
});
