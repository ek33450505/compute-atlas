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

describe("SupportPage — the personal sections", () => {
  it("names the maintainer and links his site", () => {
    render(<SupportPage />);
    const bio = screen.getByRole("link", { name: /Edward Kubiak/ });
    expect(bio).toHaveAttribute("href", "https://edwardkubiak.com");
    expect(bio).toHaveAttribute("target", "_blank");
    expect(bio).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("renders the three personal section headings in the order the page argues them", () => {
    const { container } = render(<SupportPage />);
    const headings = Array.from(container.querySelectorAll("h2")).map(
      (h) => h.textContent ?? ""
    );
    const why = headings.indexOf("Why I built this");
    const who = headings.indexOf("Who’s behind it");
    const guarantee = headings.indexOf("What support does not change");
    const stand = headings.indexOf("Where I stand");
    for (const i of [why, who, guarantee, stand]) expect(i).toBeGreaterThan(-1);
    // "Why" and "Who" make the case before the invoice; the opinion comes
    // last, and specifically AFTER the neutrality guarantee — see the ⛔ note
    // in app/support/page.tsx. Reversed, the guarantee reads as a walk-back.
    expect(why).toBeLessThan(who);
    expect(guarantee).toBeLessThan(stand);
  });

  it("disowns the opinion in the dataset's voice and routes disagreement to a correction", () => {
    render(<SupportPage />);
    // The load-bearing sentence. Without it the site's neutrality claim and
    // the maintainer's stated position sit on the page as equals.
    expect(
      screen.getByText(/That is my opinion\. It is not this dataset’s\./)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "send me a correction" })
    ).toHaveAttribute("href", "/contribute");
    expect(
      screen.getByRole("link", { name: "public change log" })
    ).toHaveAttribute("href", "/activity");
  });

  it("states no figure anywhere in the opinion section", () => {
    const { container } = render(<SupportPage />);
    const stand = container.querySelector("section[aria-labelledby='stand-heading']");
    expect(stand).not.toBeNull();
    // A number here would be an uncited claim on a site whose whole premise is
    // that claims carry sources. Mutation-tested: adding one fails this.
    expect(stand?.textContent ?? "").not.toMatch(/\d/);
  });

  it("keeps the discovery pipeline's never-published clause attached to the AI disclosure", () => {
    // Two separate sections now mention the pipeline. Both must carry the
    // clause: the AI disclosure without it reads as "the dataset is
    // AI-generated", which is false and is the worst available misreading.
    const { container } = render(<SupportPage />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/has never once published a record/);
    expect(text).toMatch(/It has never published a record\./);
    expect(text).toMatch(/a person accepts or rejects each candidate by hand/);
  });

  it("renders exactly one funding CTA, so its links keep unique accessible names", () => {
    const { container } = render(<SupportPage />);
    expect(
      container.querySelectorAll('a[href="https://ko-fi.com/L2T725R7FV"]')
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('a[href="https://github.com/sponsors/ek33450505"]')
    ).toHaveLength(1);
  });
});
