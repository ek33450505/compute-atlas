import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HeroSearch } from "./hero-search";

describe("HeroSearch", () => {
  it("renders a button with an accessible name describing the search action", () => {
    render(<HeroSearch facilityCount={1034} />);
    expect(
      screen.getByRole("button", { name: /search.*sites, operators, and states/i })
    ).toBeInTheDocument();
  });

  it("formats the facility count with thousands separators in the visible label", () => {
    render(<HeroSearch facilityCount={1034} />);
    expect(
      screen.getByText("Search 1,034 sites, operators, and states")
    ).toBeInTheDocument();
  });

  it("dispatches a compute-atlas:open-search event when clicked", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    window.addEventListener("compute-atlas:open-search", handler);

    render(<HeroSearch facilityCount={1034} />);
    await user.click(screen.getByRole("button"));

    expect(handler).toHaveBeenCalledTimes(1);

    window.removeEventListener("compute-atlas:open-search", handler);
  });
});
