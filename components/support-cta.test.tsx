import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SupportCta } from "./support-cta";

describe("SupportCta", () => {
  it("renders both funding links with the correct hrefs", () => {
    render(<SupportCta />);
    expect(
      screen.getByRole("link", { name: /Support Compute Atlas on Ko-fi/i })
    ).toHaveAttribute("href", "https://ko-fi.com/L2T725R7FV");
    expect(
      screen.getByRole("link", {
        name: /Sponsor Compute Atlas on GitHub Sponsors/i,
      })
    ).toHaveAttribute("href", "https://github.com/sponsors/ek33450505");
  });

  it("gives the two links distinct accessible names", () => {
    render(<SupportCta />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    const names = links.map((link) => link.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(2);
  });

  it("renders Ko-fi first, ahead of GitHub Sponsors, in document order", () => {
    render(<SupportCta />);
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveAccessibleName(/Support Compute Atlas on Ko-fi/i);
    expect(links[1]).toHaveAccessibleName(
      /Sponsor Compute Atlas on GitHub Sponsors/i
    );
  });

  it("opens both links in a new tab with a safe rel", () => {
    render(<SupportCta />);
    for (const link of screen.getAllByRole("link")) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noreferrer noopener");
    }
  });

  it("merges a passed className onto the wrapper", () => {
    const { container } = render(<SupportCta className="mt-8" />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain("mt-8");
    expect(wrapper?.className).toContain("flex");
  });
});
