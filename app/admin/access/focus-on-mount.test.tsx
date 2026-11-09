import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { FocusOnMount } from "./focus-on-mount";

describe("FocusOnMount", () => {
  it("focuses the element with the given id when it mounts", () => {
    render(
      <>
        <h2 id="target" tabIndex={-1}>
          Target
        </h2>
        <FocusOnMount targetId="target" />
      </>
    );
    expect(screen.getByRole("heading", { name: "Target" })).toHaveFocus();
  });

  it("does nothing when the element is absent", () => {
    render(<FocusOnMount targetId="missing" />);
    expect(document.body).toHaveFocus();
  });

  it("focuses again when remounted, e.g. keyed by a different grant", () => {
    const { rerender } = render(
      <>
        <h2 id="target" tabIndex={-1}>
          Target
        </h2>
        <input aria-label="Elsewhere" />
        <FocusOnMount key="a" targetId="target" />
      </>
    );
    screen.getByLabelText("Elsewhere").focus();
    rerender(
      <>
        <h2 id="target" tabIndex={-1}>
          Target
        </h2>
        <input aria-label="Elsewhere" />
        <FocusOnMount key="b" targetId="target" />
      </>
    );
    expect(screen.getByRole("heading", { name: "Target" })).toHaveFocus();
  });
});
