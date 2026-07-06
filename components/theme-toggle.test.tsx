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

  it("has the sr-only toggle label text", () => {
    render(<ThemeToggle />, { wrapper: Wrapper });
    expect(screen.getByText("Toggle theme")).toBeInTheDocument();
  });
});
