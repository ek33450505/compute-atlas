import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/supporters", () => ({
  SUPPORTERS: [{ name: "Example University", kind: "institution" }],
}));

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
  afterEach(() => vi.unstubAllEnvs());

  it("renders the h1", () => {
    render(<SupportPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Support the atlas" })
    ).toBeInTheDocument();
  });

  it("renders the PayPal funding link, no Ko-fi link and no GitHub Sponsors link", () => {
    const { container } = render(<SupportPage />);
    expect(
      screen.getByRole("link", { name: /Support on PayPal/i })
    ).toHaveAttribute("href", "https://www.paypal.com/paypalme/computeatlas");
    expect(container.querySelectorAll('a[href*="ko-fi.com"]')).toHaveLength(0);
    expect(container.textContent ?? "").not.toMatch(/ko-fi/i);
    expect(container.querySelectorAll('a[href*="github.com/sponsors"]')).toHaveLength(0);
  });

  it("points data seekers to /dataset", () => {
    render(<SupportPage />);
    expect(screen.getByRole("link", { name: "the dataset page" })).toHaveAttribute(
      "href",
      "/dataset"
    );
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

  it("renders the external repo link with target/rel and an accessible name containing its visible text", () => {
    render(<SupportPage />);
    const repoLink = screen.getByRole("link", {
      name: /open an issue on the repo.*\(opens in new tab\)/i,
    });
    // WCAG 2.5.3 Label in Name: the visible text leads the accessible name.
    expect(repoLink).toHaveAccessibleName(/^open an issue on the repo/i);
    expect(repoLink).toHaveAttribute(
      "href",
      "https://github.com/ek33450505/compute-atlas"
    );
    expect(repoLink).toHaveAttribute("target", "_blank");
    expect(repoLink).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("links the newsletter and Bluesky profile and states where the list is held", () => {
    const { container } = render(<SupportPage />);
    const newsletter = screen.getByRole("link", {
      name: /Subscribe to the newsletter on Buttondown/i,
    });
    expect(newsletter).toHaveAttribute("href", "https://buttondown.com/compute-atlas");
    expect(container.innerHTML).not.toMatch(/monthly newsletter/i);
    expect(newsletter).toHaveAttribute("target", "_blank");
    expect(newsletter).toHaveAttribute("rel", "noreferrer noopener");
    const bluesky = screen.getByRole("link", {
      name: /Follow Compute Atlas on Bluesky/i,
    });
    expect(bluesky).toHaveAttribute("href", "https://bsky.app/profile/compute-atlas.com");
    expect(bluesky).toHaveAttribute("target", "_blank");
    expect(bluesky).toHaveAttribute("rel", "noreferrer noopener");
    expect(container.textContent).toContain(
      "The newsletter list is held by Buttondown, not by this site, and is separate from the facility and state alerts."
    );
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
  it("names the maintainer as plain text with no link to a personal site", () => {
    const { container } = render(<SupportPage />);
    const bio = screen.getByText(/Edward Kubiak/);
    expect(bio.textContent).toContain(
      "I’m Edward Kubiak, a full-stack developer"
    );
    expect(container.querySelector('a[href*="edwardkubiak.com"]')).toBeNull();
    expect(screen.queryByRole("link", { name: /Edward Kubiak/ })).toBeNull();
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

  it("renders exactly one funding CTA, so its link keeps a unique accessible name", () => {
    const { container } = render(<SupportPage />);
    expect(
      container.querySelectorAll('a[href="https://www.paypal.com/paypalme/computeatlas"]')
    ).toHaveLength(1);
  });

  it("drops the cost ranking and keeps the discovery-pipeline guarantee", () => {
    const { container } = render(<SupportPage />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("largest");
    expect(text).toContain("It has never published a record.");
  });

  it("states the guarantee without the retired membership wording", () => {
    const { container } = render(<SupportPage />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("membership");
    expect(text).not.toContain("Nothing on this site is for sale");
    expect(text).toContain("No record, edit, removal, or place in a ranking is for sale.");
  });

  it("points organizations to the commercial subscription when the tier is on", () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "true");
    render(<SupportPage />);
    expect(
      screen.getByRole("link", { name: "the commercial subscription" })
    ).toHaveAttribute("href", "/access/commercial");
    vi.unstubAllEnvs();
  });

  it("does not link the commercial subscription when the tier is off", () => {
    vi.stubEnv("COMMERCIAL_TIER_ENABLED", "false");
    render(<SupportPage />);
    expect(
      screen.queryByRole("link", { name: "the commercial subscription" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "the contact page" })).toHaveAttribute("href", "/contact");
  });

  it("orders the guarantee, then supporters, then where I stand", () => {
    render(<SupportPage />);
    const guarantee = screen.getByRole("heading", { name: "What support does not change" });
    const supporters = screen.getByRole("heading", { name: "Supporters" });
    const stand = screen.getByRole("heading", { name: "Where I stand" });
    const follows = (a: HTMLElement, b: HTMLElement) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(guarantee, supporters)).toBe(true);
    expect(follows(supporters, stand)).toBe(true);
  });

  it("mentions one-off support before the PayPal link", () => {
    render(<SupportPage />);
    const oneOff = screen.getByText(/one-off contribution through PayPal/);
    const link = screen.getByRole("link", { name: /Support on PayPal/ });
    expect(
      Boolean(oneOff.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING)
    ).toBe(true);
  });
});
