import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname } from "next/navigation";
import { MobileNav } from "./mobile-nav";

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
    onClick,
    className,
    "aria-current": ariaCurrent,
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLAnchorElement>;
    className?: string;
    "aria-current"?: React.AriaAttributes["aria-current"];
  }) => (
    <a
      href={href}
      onClick={onClick}
      className={className}
      aria-current={ariaCurrent}
    >
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NAV_LINKS = [
  { label: "Map", href: "/map" },
  { label: "Table", href: "/table" },
  { label: "Stats", href: "/stats" },
  { label: "About", href: "/about" },
] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MobileNav — initial render", () => {
  it("renders the toggle button", () => {
    render(<MobileNav links={NAV_LINKS} />);
    expect(
      screen.getByRole("button", { name: "Open navigation menu" })
    ).toBeInTheDocument();
  });

  it("nav panel and links are not in the document initially (aria-expanded=false)", () => {
    render(<MobileNav links={NAV_LINKS} />);
    const button = screen.getByRole("button", { name: "Open navigation menu" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Map" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "About" })
    ).not.toBeInTheDocument();
  });

  it("button has aria-controls matching the panel id", () => {
    render(<MobileNav links={NAV_LINKS} />);
    const button = screen.getByRole("button", { name: "Open navigation menu" });
    expect(button).toHaveAttribute("aria-controls", "mobile-nav-panel");
    expect(button).not.toHaveAttribute("aria-haspopup");
  });
});

describe("MobileNav — open state", () => {
  it("clicking the button opens the panel: aria-expanded becomes true and links appear", async () => {
    const user = userEvent.setup();
    render(<MobileNav links={NAV_LINKS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );

    const button = screen.getByRole("button", { name: "Close navigation menu" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Map" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "About" })).toBeInTheDocument();
  });

  it("panel contains a GitHub source link", async () => {
    const user = userEvent.setup();
    render(<MobileNav links={NAV_LINKS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );

    expect(
      screen.getByRole("link", {
        name: "View source on GitHub (opens in new tab)",
      })
    ).toBeInTheDocument();
  });
});

describe("MobileNav — close behavior", () => {
  it("pressing Escape closes the panel (aria-expanded returns to false)", async () => {
    const user = userEvent.setup();
    render(<MobileNav links={NAV_LINKS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );
    // Verify it opened
    expect(
      screen.getByRole("button", { name: "Close navigation menu" })
    ).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");

    expect(
      screen.getByRole("button", { name: "Open navigation menu" })
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Map" })).not.toBeInTheDocument();
  });

  it("clicking a nav link closes the panel", async () => {
    const user = userEvent.setup();
    render(<MobileNav links={NAV_LINKS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );
    await user.click(screen.getByRole("link", { name: "Map" }));

    expect(
      screen.getByRole("button", { name: "Open navigation menu" })
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Map" })).not.toBeInTheDocument();
  });

  it("clicking the GitHub source link closes the panel", async () => {
    const user = userEvent.setup();
    render(<MobileNav links={NAV_LINKS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );
    await user.click(
      screen.getByRole("link", {
        name: "View source on GitHub (opens in new tab)",
      })
    );

    expect(
      screen.queryByRole("link", {
        name: "View source on GitHub (opens in new tab)",
      })
    ).not.toBeInTheDocument();
  });

  it("pointer-down outside the container closes the panel", async () => {
    const user = userEvent.setup();
    render(<MobileNav links={NAV_LINKS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );

    const button = screen.getByRole("button", { name: "Close navigation menu" });
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Map" })).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(
      screen.getByRole("button", { name: "Open navigation menu" })
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Map" })).not.toBeInTheDocument();
  });

  it("pressing Escape returns focus to the toggle button", async () => {
    const user = userEvent.setup();
    render(<MobileNav links={NAV_LINKS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );
    expect(
      screen.getByRole("button", { name: "Close navigation menu" })
    ).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(document, { key: "Escape" });

    // Panel closes synchronously; focus returns via requestAnimationFrame
    expect(
      screen.queryByRole("link", { name: "Map" })
    ).not.toBeInTheDocument();
    const toggleButton = screen.getByRole("button", {
      name: "Open navigation menu",
    });
    await waitFor(() => expect(toggleButton).toHaveFocus());
    expect(toggleButton).toHaveAttribute("aria-expanded", "false");
  });
});

describe("MobileNav — aria-current", () => {
  it("sets aria-current=page on the active route link (non-root)", async () => {
    vi.mocked(usePathname).mockReturnValue("/map");
    const user = userEvent.setup();
    render(<MobileNav links={NAV_LINKS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );

    expect(screen.getByRole("link", { name: "Map" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("link", { name: "About" })).not.toHaveAttribute(
      "aria-current",
      "page"
    );

    // Reset mock so other tests see "/"
    vi.mocked(usePathname).mockReturnValue("/");
  });
});
