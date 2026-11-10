import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { StateChips } from "./state-chips";

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

describe("StateChips", () => {
  it("links each state by full name to its slug", () => {
    render(
      <StateChips
        states={[
          { state: "TX", count: 9 },
          { state: "NY", count: 3 },
        ]}
      />
    );
    expect(screen.getByRole("link", { name: "Texas" })).toHaveAttribute("href", "/states/texas");
    expect(screen.getByRole("link", { name: "New York" })).toHaveAttribute("href", "/states/new-york");
  });

  it("skips unknown codes and always ends with All states", () => {
    render(<StateChips states={[{ state: "ZZ", count: 1 }, { state: "OH", count: 1 }]} />);
    expect(screen.queryByRole("link", { name: "ZZ" })).toBeNull();
    const links = screen.getAllByRole("link");
    expect(links[links.length - 1]).toHaveAttribute("href", "/states");
    expect(links[links.length - 1]).toHaveTextContent("All states");
  });

  it("renders nothing when no state resolves", () => {
    const { container } = render(<StateChips states={[{ state: "ZZ", count: 1 }]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
