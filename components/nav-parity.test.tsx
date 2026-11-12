import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { getSiteNavGroups } from "@/lib/site-nav";
import { MobileNav } from "./mobile-nav";
import { SiteFooter } from "./site-footer";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn().mockReturnValue("/"),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

interface Shape {
  label: string;
  links: { text: string; href: string }[];
}

function readGroups(root: HTMLElement, groupSelector: string): Shape[] {
  return Array.from(root.querySelectorAll(groupSelector)).map((group) => ({
    label: group.querySelector("p")!.textContent!.trim(),
    links: Array.from(group.querySelectorAll("a")).map((a) => ({
      text: a.textContent!.replace("↗", "").trim(),
      href: a.getAttribute("href")!,
    })),
  }));
}

describe("footer and mobile sheet render the same groups", () => {
  for (const [name, sharing, commercial] of [
    ["both flags on", "true", "true"],
    ["sharing on, commercial off", "true", ""],
    ["both flags off", "", ""],
  ] as const) {
    it(`same group labels, link labels and hrefs (${name})`, async () => {
      vi.stubEnv("DATASET_SHARING_ENABLED", sharing);
      vi.stubEnv("COMMERCIAL_TIER_ENABLED", commercial);

      const { container } = render(<SiteFooter />);
      const footer = readGroups(container, "footer div.space-y-2");
      expect(footer.map((g) => g.label)).toEqual(getSiteNavGroups().map((g) => g.label));

      const user = userEvent.setup();
      render(<MobileNav groups={getSiteNavGroups()} />);
      await user.click(screen.getByRole("button", { name: "Open navigation menu" }));
      const nav = await screen.findByRole("navigation", { name: "Mobile navigation" });
      const mobile = readGroups(nav, "div.mb-6");

      expect(mobile).toEqual(footer);
      expect(within(nav).getAllByRole("link").length).toBeGreaterThan(15);
    });
  }
});
