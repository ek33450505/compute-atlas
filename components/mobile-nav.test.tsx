import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

const GROUPS = [
  {
    label: "Tools",
    links: [
      { label: "Map", href: "/map" },
      { label: "Table", href: "/table" },
      { label: "Stats", href: "/stats" },
    ],
  },
  {
    label: "Project",
    links: [
      { label: "About", href: "/about" },
      {
        label: "Source on GitHub",
        href: "https://github.com/example/repo",
        external: true,
      },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MobileNav — initial render", () => {
  it("renders the toggle button", () => {
    render(<MobileNav groups={GROUPS} />);
    expect(
      screen.getByRole("button", { name: "Open navigation menu" })
    ).toBeInTheDocument();
  });

  it("panel and links are not in the document initially (aria-expanded=false)", () => {
    render(<MobileNav groups={GROUPS} />);
    const button = screen.getByRole("button", { name: "Open navigation menu" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Map" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "About" })).not.toBeInTheDocument();
  });

  it("button has aria-controls matching the panel id", () => {
    render(<MobileNav groups={GROUPS} />);
    const button = screen.getByRole("button", { name: "Open navigation menu" });
    expect(button).toHaveAttribute("aria-controls", "mobile-nav-panel");
  });
});

describe("MobileNav — responsive breakpoint", () => {
  // Companion to the PrimaryNav breakpoint test: PrimaryNav now only reveals
  // at md: (768px) — see components/primary-nav.test.tsx — so this toggle
  // must stay visible through the whole sub-768px range (it used to hide at
  // sm:, 640px). A stale "sm:hidden" here would reopen a dead zone from
  // 640-767px where NEITHER the inline nav NOR the hamburger is reachable.
  it("hides at the md: (768px) breakpoint, not sm: (640px)", () => {
    render(<MobileNav groups={GROUPS} />);
    const toggle = screen.getByRole("button", { name: "Open navigation menu" });

    expect(toggle).toHaveClass("md:hidden");
    expect(toggle).not.toHaveClass("sm:hidden");
  });
});

describe("MobileNav — open state", () => {
  it("clicking the button opens the panel: aria-expanded becomes true and links appear", async () => {
    const user = userEvent.setup();
    render(<MobileNav groups={GROUPS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );

    expect(await screen.findByRole("link", { name: "Map" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "About" })).toBeInTheDocument();

    // The toggle button becomes inert (removed from the accessibility tree)
    // once the modal dialog traps focus, so it's asserted via a raw DOM
    // query rather than screen.getByRole — the panel's own close button
    // shares the "Close navigation menu" accessible name while open, so a
    // role query at this point would be ambiguous by design.
    const toggle = document.querySelector('button[aria-controls="mobile-nav-panel"]');
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-label", "Close navigation menu");

    // The panel's own close button remains the sole accessible match.
    expect(
      screen.getByRole("button", { name: "Close navigation menu" })
    ).toBeInTheDocument();
  });

  it("groups links under labeled sections", async () => {
    const user = userEvent.setup();
    render(<MobileNav groups={GROUPS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );

    await screen.findByRole("link", { name: "Map" });
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("Project")).toBeInTheDocument();
  });

  it("panel contains the external GitHub link with a new-tab accessible name", async () => {
    const user = userEvent.setup();
    render(<MobileNav groups={GROUPS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );

    expect(
      await screen.findByRole("link", {
        name: "Source on GitHub (opens in new tab)",
      })
    ).toBeInTheDocument();
  });
});

describe("MobileNav — close behavior", () => {
  it("pressing Escape closes the panel (aria-expanded returns to false)", async () => {
    const user = userEvent.setup();
    render(<MobileNav groups={GROUPS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );
    await screen.findByRole("link", { name: "Map" });

    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open navigation menu" })
      ).toHaveAttribute("aria-expanded", "false")
    );
    expect(screen.queryByRole("link", { name: "Map" })).not.toBeInTheDocument();
  });

  it("pressing Escape returns focus to the toggle button", async () => {
    const user = userEvent.setup();
    render(<MobileNav groups={GROUPS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );
    await screen.findByRole("link", { name: "Map" });

    await user.keyboard("{Escape}");

    const toggleButton = screen.getByRole("button", {
      name: "Open navigation menu",
    });
    await waitFor(() => expect(toggleButton).toHaveFocus());
  });

  it("an outside press (e.g. on the backdrop) closes the panel", async () => {
    const user = userEvent.setup();
    render(<MobileNav groups={GROUPS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );
    await screen.findByRole("link", { name: "Map" });

    // Base UI's dismiss handling needs a full pointer down/up + click
    // sequence (userEvent.click), not a bare fireEvent.pointerDown, to
    // register as an outside press — verified empirically.
    await user.click(document.body);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open navigation menu" })
      ).toHaveAttribute("aria-expanded", "false")
    );
    expect(screen.queryByRole("link", { name: "Map" })).not.toBeInTheDocument();
  });

  it("clicking a nav link closes the panel", async () => {
    const user = userEvent.setup();
    render(<MobileNav groups={GROUPS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );
    await user.click(await screen.findByRole("link", { name: "Map" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open navigation menu" })
      ).toHaveAttribute("aria-expanded", "false")
    );
    expect(screen.queryByRole("link", { name: "Map" })).not.toBeInTheDocument();
  });

  it("clicking the external GitHub link closes the panel too", async () => {
    const user = userEvent.setup();
    render(<MobileNav groups={GROUPS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );
    await user.click(
      await screen.findByRole("link", {
        name: "Source on GitHub (opens in new tab)",
      })
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open navigation menu" })
      ).toHaveAttribute("aria-expanded", "false")
    );
  });

  it("clicking the close button closes the panel", async () => {
    const user = userEvent.setup();
    render(<MobileNav groups={GROUPS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );
    await user.click(
      screen.getByRole("button", { name: "Close navigation menu" })
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open navigation menu" })
      ).toHaveAttribute("aria-expanded", "false")
    );
  });
});

describe("MobileNav — aria-current", () => {
  it("sets aria-current=page on the active route link only", async () => {
    vi.mocked(usePathname).mockReturnValue("/map");
    const user = userEvent.setup();
    render(<MobileNav groups={GROUPS} />);

    await user.click(
      screen.getByRole("button", { name: "Open navigation menu" })
    );

    expect(await screen.findByRole("link", { name: "Map" })).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByRole("link", { name: "About" })).not.toHaveAttribute(
      "aria-current",
      "page"
    );

    vi.mocked(usePathname).mockReturnValue("/");
  });
});
