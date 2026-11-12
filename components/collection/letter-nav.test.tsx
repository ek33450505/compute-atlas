import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { LetterNav } from "./letter-nav";

describe("LetterNav", () => {
  it("links only the available letters and marks the current one", () => {
    render(
      <LetterNav
        basePath="/operators"
        label="Operators by first letter"
        available={new Set(["a", "c"])}
        current="c"
      />
    );
    const nav = screen.getByRole("navigation", { name: "Operators by first letter" });
    const links = nav.querySelectorAll("a");
    expect([...links].map((a) => a.getAttribute("href"))).toEqual([
      "/operators?letter=a",
      "/operators?letter=c",
    ]);
    expect(screen.getByRole("link", { name: "C" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "A" })).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("link", { name: "B" })).not.toBeInTheDocument();
  });
});
