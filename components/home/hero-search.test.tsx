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

  it("starts its accessible name with the visible label and ⌘K hint, which are separated by whitespace", () => {
    render(<HeroSearch facilityCount={1034} />);
    const button = screen.getByRole("button", {
      name: "Search 1,034 sites, operators, and states ⌘K, opens a search dialog",
    });
    // WCAG 2.5.3 + axe: the label and <kbd> are flex siblings; a text node gives axe a word boundary.
    expect(button.textContent).toMatch(/states\s+⌘K/);
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
