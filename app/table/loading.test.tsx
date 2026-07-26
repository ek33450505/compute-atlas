import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Loading from "./loading";

describe("table Loading", () => {
  it("renders an accessible loading status region", () => {
    render(<Loading />);
    expect(screen.getByRole("status", { name: "Loading…" })).toBeInTheDocument();
  });
});
