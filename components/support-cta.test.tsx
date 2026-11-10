import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { SupportCta } from "./support-cta";

describe("SupportCta", () => {
  it("renders a single internal link to /support", () => {
    render(<SupportCta />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName("Ways to support");
    expect(links[0]).toHaveAttribute("href", "/support");
    expect(links[0]).not.toHaveAttribute("target");
  });

  it("mentions no third-party funding service or donation wording", () => {
    const { container } = render(<SupportCta />);
    expect(container.innerHTML).not.toMatch(/ko-?fi|donat|tax-deductible|github\.com/i);
  });

  it.each(["default", "compact"] as const)("%s size renders the same label", (size) => {
    render(<SupportCta size={size} />);
    expect(screen.getByRole("link")).toHaveTextContent("Ways to support");
  });

  it("server-renders the label and its arrow in one text run (no <!-- --> split)", () => {
    const html = renderToString(<SupportCta />);
    expect(html).toContain("Ways to support <span");
    expect(html).not.toContain("<!-- -->");
  });

  it("uses an outline, not a box-shadow ring, for focus (forced-colors safe)", () => {
    render(<SupportCta />);
    const link = screen.getByRole("link");
    expect(link).toHaveClass("focus-visible:outline-2", "focus-visible:outline-ring");
    expect(link).not.toHaveClass("focus-visible:ring-2");
    expect(link).not.toHaveClass("focus-visible:outline-none");
  });

  it("keeps default sizing, and applies compact only on request", () => {
    const { rerender } = render(<SupportCta />);
    expect(screen.getByRole("link")).toHaveClass("h-11", "px-5");
    rerender(<SupportCta size="compact" />);
    expect(screen.getByRole("link")).toHaveClass("px-3", "text-xs", "sm:min-h-9");
  });

  it("merges a passed className onto the wrapper", () => {
    const { container } = render(<SupportCta className="mt-8" />);
    expect(container.firstElementChild).toHaveClass("mt-8");
  });
});
