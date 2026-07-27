import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ShowMoreList } from "./show-more-list";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeItems(count: number) {
  return Array.from({ length: count }, (_, i) => (
    <div key={`item-${i + 1}`}>Item {i + 1}</div>
  ));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ShowMoreList", () => {
  it("renders all items visible and no button when the count is at or under initialCount", () => {
    render(<ShowMoreList initialCount={5}>{makeItems(5)}</ShowMoreList>);

    for (let i = 1; i <= 5; i++) {
      expect(screen.getByText(`Item ${i}`)).toBeVisible();
    }
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("collapses items beyond initialCount behind the hidden attribute and shows a Show more button", () => {
    render(
      <ShowMoreList initialCount={3} itemLabel="facilities">
        {makeItems(5)}
      </ShowMoreList>
    );

    for (let i = 1; i <= 3; i++) {
      expect(screen.getByText(`Item ${i}`)).toBeVisible();
    }
    // Beyond initialCount: present in the DOM (SEO/crawlable) but collapsed
    // via the `hidden` attribute — jest-dom's toBeVisible() walks the
    // ancestor chain checking for `hidden`, so this catches the wrapper div.
    for (let i = 4; i <= 5; i++) {
      expect(screen.getByText(`Item ${i}`)).not.toBeVisible();
    }

    const button = screen.getByRole("button", { name: "Show 2 more facilities" });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("omits the item-label suffix when itemLabel is not provided", () => {
    render(<ShowMoreList initialCount={2}>{makeItems(4)}</ShowMoreList>);
    expect(screen.getByRole("button", { name: "Show 2 more" })).toBeInTheDocument();
  });

  it("reveals every item and removes the button when clicked", async () => {
    const user = userEvent.setup();
    render(
      <ShowMoreList initialCount={3} itemLabel="facilities">
        {makeItems(5)}
      </ShowMoreList>
    );

    await user.click(screen.getByRole("button", { name: "Show 2 more facilities" }));

    for (let i = 1; i <= 5; i++) {
      expect(screen.getByText(`Item ${i}`)).toBeVisible();
    }
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("is a real, keyboard-activatable button", async () => {
    const user = userEvent.setup();
    render(<ShowMoreList initialCount={2}>{makeItems(4)}</ShowMoreList>);

    const button = screen.getByRole("button", { name: "Show 2 more" });
    expect(button.tagName).toBe("BUTTON");

    button.focus();
    expect(button).toHaveFocus();
    await user.keyboard("{Enter}");

    for (let i = 1; i <= 4; i++) {
      expect(screen.getByText(`Item ${i}`)).toBeVisible();
    }
  });

  it("applies className to the wrapper that lays out the items", () => {
    const { container } = render(
      <ShowMoreList initialCount={5} className="grid grid-cols-3">
        {makeItems(2)}
      </ShowMoreList>
    );
    expect(container.querySelector(".grid.grid-cols-3")).not.toBeNull();
  });
});
