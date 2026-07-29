import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { GLOSSARY_TOPICS } from "@/lib/glossary";

// next/link renders to <a> — mock to avoid Next.js router-context dependency in jsdom
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

import LearnIndexPage from "./page";

describe("LearnIndexPage", () => {
  it("renders without throwing and shows the main heading", () => {
    render(<LearnIndexPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Data center glossary" })
    ).toBeInTheDocument();
  });

  it("renders a link for every topic in the glossary registry, pointing at /learn/{slug}", () => {
    render(<LearnIndexPage />);

    for (const { slug, title } of GLOSSARY_TOPICS) {
      const link = screen.getByRole("link", { name: new RegExp(title) });
      expect(link).toHaveAttribute("href", `/learn/${slug}`);
    }
  });

  it("shows each topic's dek text alongside its title", () => {
    render(<LearnIndexPage />);

    for (const { dek } of GLOSSARY_TOPICS) {
      expect(screen.getByText(dek)).toBeInTheDocument();
    }
  });
});
