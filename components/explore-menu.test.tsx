import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname } from "next/navigation";
import { ExploreMenu } from "./explore-menu";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  usePathname: vi.fn().mockReturnValue("/"),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    "aria-current": ariaCurrent,
  }: {
    href: string;
    children: React.ReactNode;
    "aria-current"?: React.AriaAttributes["aria-current"];
  }) => (
    <a href={href} aria-current={ariaCurrent}>
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LINKS = [
  { label: "States", href: "/states" },
  { label: "Power", href: "/power" },
] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExploreMenu — trigger", () => {
  it("renders the Explore trigger as a button", () => {
    render(<ExploreMenu links={LINKS} />);
    expect(
      screen.getByRole("button", { name: /explore/i })
    ).toBeInTheDocument();
  });

  it("the trigger exposes menu semantics via aria-haspopup", () => {
    render(<ExploreMenu links={LINKS} />);
    const trigger = screen.getByRole("button", { name: /explore/i });
    expect(trigger).toHaveAttribute("aria-haspopup");
  });

  it("does not mark Explore active when the current route is unrelated", () => {
    vi.mocked(usePathname).mockReturnValue("/");
    render(<ExploreMenu links={LINKS} />);
    const trigger = screen.getByRole("button", { name: /explore/i });
    expect(trigger.classList.contains("text-foreground")).toBe(false);
  });

  it("marks Explore active when the current route matches a menu link", () => {
    vi.mocked(usePathname).mockReturnValue("/states");
    render(<ExploreMenu links={LINKS} />);
    const trigger = screen.getByRole("button", { name: /explore/i });
    expect(trigger.classList.contains("text-foreground")).toBe(true);
    vi.mocked(usePathname).mockReturnValue("/");
  });

  it("marks Explore active for a nested route under a menu link", () => {
    vi.mocked(usePathname).mockReturnValue("/states/texas");
    render(<ExploreMenu links={LINKS} />);
    const trigger = screen.getByRole("button", { name: /explore/i });
    expect(trigger.classList.contains("text-foreground")).toBe(true);
    vi.mocked(usePathname).mockReturnValue("/");
  });
});

describe("ExploreMenu — opened menu", () => {
  it("opening the menu reveals the provided links as navigable menu items", async () => {
    const user = userEvent.setup();
    render(<ExploreMenu links={LINKS} />);

    await user.click(screen.getByRole("button", { name: /explore/i }));

    // Base UI's Menu popup mounts asynchronously. Links are rendered via
    // the render prop, which replaces the menuitem role with link role.
    const statesLink = await screen.findByRole("link", { name: "States" });
    const powerLink = screen.getByRole("link", { name: "Power" });
    expect(statesLink).toHaveAttribute("href", "/states");
    expect(powerLink).toHaveAttribute("href", "/power");
  });

  it("sets aria-current=page on the link matching the active route", async () => {
    vi.mocked(usePathname).mockReturnValue("/power");
    const user = userEvent.setup();
    render(<ExploreMenu links={LINKS} />);

    await user.click(screen.getByRole("button", { name: /explore/i }));

    const powerLink = await screen.findByRole("link", { name: "Power" });
    await waitFor(() => {
      expect(powerLink).toHaveAttribute("aria-current", "page");
    });
    expect(screen.getByRole("link", { name: "States" })).not.toHaveAttribute(
      "aria-current",
      "page"
    );
    vi.mocked(usePathname).mockReturnValue("/");
  });

  it("sets aria-current=page for nested routes matching a link's href prefix", async () => {
    vi.mocked(usePathname).mockReturnValue("/power/generation/nuclear");
    const user = userEvent.setup();
    render(<ExploreMenu links={LINKS} />);

    await user.click(screen.getByRole("button", { name: /explore/i }));

    const powerLink = await screen.findByRole("link", { name: "Power" });
    await waitFor(() => {
      expect(powerLink).toHaveAttribute("aria-current", "page");
    });
    expect(screen.getByRole("link", { name: "States" })).not.toHaveAttribute(
      "aria-current",
      "page"
    );
    vi.mocked(usePathname).mockReturnValue("/");
  });

  it("renders correctly with a single link", async () => {
    const user = userEvent.setup();
    const singleLink = [{ label: "Single", href: "/single" }] as const;
    render(<ExploreMenu links={singleLink} />);

    await user.click(screen.getByRole("button", { name: /explore/i }));

    const link = await screen.findByRole("link", { name: "Single" });
    expect(link).toHaveAttribute("href", "/single");
  });

  it("renders correctly with multiple links", async () => {
    const user = userEvent.setup();
    const multipleLinks = [
      { label: "A", href: "/a" },
      { label: "B", href: "/b" },
      { label: "C", href: "/c" },
    ] as const;
    render(<ExploreMenu links={multipleLinks} />);

    await user.click(screen.getByRole("button", { name: /explore/i }));

    const aLink = await screen.findByRole("link", { name: "A" });
    const bLink = screen.getByRole("link", { name: "B" });
    const cLink = screen.getByRole("link", { name: "C" });
    expect(aLink).toHaveAttribute("href", "/a");
    expect(bLink).toHaveAttribute("href", "/b");
    expect(cLink).toHaveAttribute("href", "/c");
  });
});
