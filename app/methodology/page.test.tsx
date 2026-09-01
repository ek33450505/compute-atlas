import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// next/link renders to <a> — mock to avoid Next.js router-context dependency
// in jsdom (same pattern as app/support/page.test.tsx).
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

import MethodologyPage, { metadata } from "./page";

describe("MethodologyPage", () => {
  it("renders exactly one h1, matching the masthead title", () => {
    render(<MethodologyPage />);
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Methodology");
  });

  it("renders known section headings from docs/methodology.md as h2s", () => {
    render(<MethodologyPage />);
    expect(
      screen.getByRole("heading", { level: 2, name: "How facilities are discovered" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "The sourcing standard" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Cooling type" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "See also" })
    ).toBeInTheDocument();
  });

  it("assigns the #cooling-type id, matching the anchor extract-fields.ts cites", () => {
    render(<MethodologyPage />);
    const heading = screen.getByRole("heading", { level: 2, name: "Cooling type" });
    expect(heading).toHaveAttribute("id", "cooling-type");
  });

  it("rewrites every relative doc link (../CONTRIBUTING.md) to the GitHub blob URL", () => {
    render(<MethodologyPage />);
    const links = screen.getAllByRole("link", { name: /CONTRIBUTING\.md/ });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute(
        "href",
        "https://github.com/ek33450505/compute-atlas/blob/main/CONTRIBUTING.md"
      );
      expect(link).toHaveAttribute("target", "_blank");
    }
  });

  it("sets the canonical alternate to /methodology", () => {
    expect(metadata.alternates).toEqual({ canonical: "/methodology" });
  });

  it("keeps raw HTML entities out of metadata string props, which JSX does not decode", () => {
    const strings = [metadata.title, metadata.description].filter(
      (v): v is string => typeof v === "string"
    );
    expect(strings.length).toBeGreaterThan(0);
    for (const s of strings) {
      expect(s).not.toMatch(/&(mdash|ndash|rsquo|lsquo|middot|amp|nbsp);/);
    }
  });
});
