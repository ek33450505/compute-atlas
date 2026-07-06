import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThemeProvider } from "./theme-provider";
import { ThemeToggle } from "./theme-toggle";

function Wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

describe("ThemeToggle", () => {
  it("renders a button with accessible name 'Toggle color theme'", () => {
    render(<ThemeToggle />, { wrapper: Wrapper });
    const button = screen.getByRole("button", { name: /toggle color theme/i });
    expect(button).toBeInTheDocument();
  });

  it("does not render a redundant visible sr-only label", () => {
    render(<ThemeToggle />, { wrapper: Wrapper });
    // The aria-label on the trigger is the only accessible name — no duplicate span.
    expect(screen.queryByText("Toggle theme")).not.toBeInTheDocument();
  });
});
