import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Skeleton } from "./skeleton";

describe("Skeleton", () => {
  // jsdom can't evaluate the prefers-reduced-motion media query itself, so this
  // asserts the class contract instead: animate-pulse must be paired with the
  // motion-reduce: variant that disables it.
  it("gates the pulse animation behind motion-reduce", () => {
    const { container } = render(<Skeleton />);
    const el = container.querySelector('[data-slot="skeleton"]');
    expect(el).toHaveClass("animate-pulse", "motion-reduce:animate-none");
  });

  it("merges a passed className", () => {
    const { container } = render(<Skeleton className="h-4 w-10" />);
    const el = container.querySelector('[data-slot="skeleton"]');
    expect(el).toHaveClass("h-4", "w-10");
  });
});
