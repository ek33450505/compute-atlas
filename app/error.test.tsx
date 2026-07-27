import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// Aliased: the default export is named `Error`, which would otherwise shadow
// the global `Error` constructor used below to build the fixture.
import ErrorBoundary from "./error";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Error boundary (app/error.tsx)", () => {
  it("renders an h1 with the error heading", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ErrorBoundary error={new Error("boom")} reset={() => {}} />);
    expect(
      screen.getByRole("heading", { level: 1, name: "The atlas couldn't load this" })
    ).toBeInTheDocument();
  });

  it("calls reset when 'Try again' is clicked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<ErrorBoundary error={new Error("boom")} reset={reset} />);

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("renders a link back to the home page", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ErrorBoundary error={new Error("boom")} reset={() => {}} />);
    expect(screen.getByRole("link", { name: "Back to the map" })).toHaveAttribute(
      "href",
      "/"
    );
  });

  it("logs the error to console.error", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("boom");
    render(<ErrorBoundary error={error} reset={() => {}} />);
    expect(consoleSpy).toHaveBeenCalledWith(error);
  });
});
