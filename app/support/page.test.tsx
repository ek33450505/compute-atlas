import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import SupportPage, { metadata } from "./page";

// next/link renders to <a> — mock to avoid Next.js router-context dependency
// in jsdom (same pattern as components/site-footer.test.tsx).
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => (
    <a href={href} className={className} {...rest}>
      {children}
    </a>
  ),
}));

describe("SupportPage", () => {
  it("renders the h1", () => {
    render(<SupportPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Support the atlas" })
    ).toBeInTheDocument();
  });

  it("renders both funding links with distinct accessible names and correct hrefs", () => {
    render(<SupportPage />);
    expect(
      screen.getByRole("link", { name: /Support Compute Atlas on Ko-fi/i })
    ).toHaveAttribute("href", "https://ko-fi.com/L2T725R7FV");
    expect(
      screen.getByRole("link", { name: /Sponsor Compute Atlas on GitHub Sponsors/i })
    ).toHaveAttribute("href", "https://github.com/sponsors/ek33450505");
  });

  it("renders the internal links to /contribute, /activity, and /about", () => {
    render(<SupportPage />);
    expect(screen.getByRole("link", { name: "Share a lead" })).toHaveAttribute(
      "href",
      "/contribute"
    );
    expect(
      screen.getByRole("link", { name: "Send a correction" })
    ).toHaveAttribute("href", "/contribute");
    expect(screen.getByRole("link", { name: "change log" })).toHaveAttribute(
      "href",
      "/activity"
    );
    expect(
      screen.getByRole("link", { name: "about & method" })
    ).toHaveAttribute("href", "/about");
  });

  it("renders the breadcrumb's /about link separately from the in-body about & method link", () => {
    render(<SupportPage />);
    expect(screen.getByRole("link", { name: "About" })).toHaveAttribute(
      "href",
      "/about"
    );
  });

  it("renders the external repo link with target/rel and a descriptive aria-label", () => {
    render(<SupportPage />);
    const repoLink = screen.getByRole("link", {
      name: /View the Compute Atlas repository on GitHub/i,
    });
    expect(repoLink).toHaveAttribute(
      "href",
      "https://github.com/ek33450505/compute-atlas"
    );
    expect(repoLink).toHaveAttribute("target", "_blank");
    expect(repoLink).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("renders real em dashes and curly apostrophes, never the literal HTML entity source", () => {
    const { container } = render(<SupportPage />);
    const text = container.textContent ?? "";
    expect(text).toContain("—");
    expect(text).not.toContain("&mdash;");
    expect(text).not.toContain("&rsquo;");
  });

  it("keeps raw HTML entities out of metadata string props, which JSX does not decode", () => {
    const strings = [metadata.title, metadata.description].filter(
      (v): v is string => typeof v === "string"
    );
    expect(strings).toHaveLength(2);
    for (const s of strings) {
      expect(s).not.toMatch(/&(mdash|ndash|rsquo|lsquo|middot|amp|nbsp);/);
    }
  });
});
