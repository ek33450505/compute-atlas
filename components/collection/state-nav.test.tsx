import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { StateNav } from "./state-nav";

describe("StateNav", () => {
  it("renders a crawlable link per state with a count, and marks the current one", () => {
    render(
      <StateNav
        basePath="/power"
        label="Power projects by state"
        states={[
          ["TX", 1],
          ["VA", 3],
        ]}
        current="VA"
        noun={["project", "projects"]}
      />
    );

    const nav = screen.getByRole("navigation", { name: "Power projects by state" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Texas/ })).toHaveAttribute("href", "/power?state=tx");
    expect(screen.getByRole("link", { name: /Texas/ })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: /Virginia/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("1 project")).toBeInTheDocument();
    expect(screen.getByText("3 projects")).toBeInTheDocument();
  });
});
