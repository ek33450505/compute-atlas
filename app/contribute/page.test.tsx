import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// next/link renders to <a> — mock to avoid Next.js router-context dependency
// in jsdom (same pattern as app/crypto/page.test.tsx / app/gaps/page.test.tsx).
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

import ContributePage from "./page";

describe("ContributePage", () => {
  it("renders a pointer link to /gaps with an accessible name", () => {
    render(<ContributePage />);

    const gapsLink = screen.getByRole("link", {
      name: /see where the dataset needs help/i,
    });
    expect(gapsLink).toHaveAttribute("href", "/gaps");
  });

  it("keeps the existing 'Support the atlas' heading and link intact", () => {
    render(<ContributePage />);

    expect(
      screen.getByRole("heading", { level: 2, name: "Support the atlas" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /more on how compute atlas is funded/i })
    ).toHaveAttribute("href", "/support");
  });
});
