import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { SupportCta } from "./support-cta";

describe("SupportCta", () => {
  it("renders a single Ko-fi link with the correct href", () => {
    render(<SupportCta />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName("Support on Ko-fi (opens in new tab)");
    expect(links[0]).toHaveAttribute("href", "https://ko-fi.com/L2T725R7FV");
  });

  it("does not offer GitHub Sponsors on the site", () => {
    const { container } = render(<SupportCta />);
    expect(screen.queryByRole("link", { name: /github/i })).not.toBeInTheDocument();
    // href-based too: a re-added link with a neutral name would slip past the name query.
    expect(container.querySelectorAll('a[href*="github.com"]')).toHaveLength(0);
  });

  it("opens in a new tab with a safe rel", () => {
    render(<SupportCta />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it.each(["default", "compact"] as const)(
    "%s size: same label, and the accessible name starts with the visible text (WCAG 2.5.3)",
    (size) => {
      render(<SupportCta size={size} />);
      const link = screen.getByRole("link");
      const visible = Array.from(link.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join("")
        .trim();
      expect(visible).toBe("Support on Ko-fi");
      expect(link.getAttribute("aria-label")?.startsWith(visible)).toBe(true);
    },
  );

  it("server-renders the label and its arrow in one text run (no <!-- --> split)", () => {
    const html = renderToString(<SupportCta />);
    expect(html).toContain("Support on Ko-fi <span");
    expect(html).not.toContain("<!-- -->");
  });

  it("uses an outline, not a box-shadow ring, for focus (forced-colors safe)", () => {
    render(<SupportCta />);
    expect(screen.getByRole("link")).toHaveClass(
      "focus-visible:outline-2",
      "focus-visible:outline-ring",
    );
    expect(screen.getByRole("link")).not.toHaveClass("focus-visible:ring-2");
    // outline-none beside outline-2 would force outline-style: none and hide the indicator
    expect(screen.getByRole("link")).not.toHaveClass("focus-visible:outline-none");
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
