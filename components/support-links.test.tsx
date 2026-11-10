import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { SupportLinks } from "./support-links";
import { parseSupportLink } from "@/lib/site";

const NONE = { monthly5: null, monthly15: null, monthly50: null, oneOff: null };

describe("SupportLinks", () => {
  it("renders nothing when no link is configured", () => {
    const { container } = render(<SupportLinks links={NONE} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders only the configured links, as safe external anchors", () => {
    render(
      <SupportLinks
        links={{ ...NONE, monthly15: "https://buy.stripe.com/abc", oneOff: "https://buy.stripe.com/xyz" }}
      />,
    );
    const monthly = screen.getByRole("link", { name: "$15 a month (opens Stripe checkout in new tab)" });
    expect(monthly).toHaveAttribute("href", "https://buy.stripe.com/abc");
    expect(monthly).toHaveAttribute("target", "_blank");
    expect(monthly).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: /\$5 a month/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /\$50 a month/ })).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /one-off tip/ }),
    ).toHaveAttribute("href", "https://buy.stripe.com/xyz");
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("omits the Monthly heading when only the one-off link is set", () => {
    render(<SupportLinks links={{ ...NONE, oneOff: "https://buy.stripe.com/xyz" }} />);
    expect(screen.queryByRole("heading", { name: "Monthly" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "One-off" })).toBeInTheDocument();
  });

  it("each visible label is a prefix of its accessible name (WCAG 2.5.3)", () => {
    render(
      <SupportLinks
        links={{
          monthly5: "https://buy.stripe.com/a",
          monthly15: "https://buy.stripe.com/b",
          monthly50: "https://buy.stripe.com/c",
          oneOff: "https://buy.stripe.com/d",
        }}
      />,
    );
    for (const link of screen.getAllByRole("link")) {
      const visible = (link.textContent ?? "").replace("↗", "").trim();
      expect(link.getAttribute("aria-label")?.startsWith(visible)).toBe(true);
    }
    expect(document.body.innerHTML).not.toMatch(/ko-?fi|donat|tax-deductible/i);
  });
});

describe("parseSupportLink", () => {
  it.each([
    [undefined, null],
    ["", null],
    ["   ", null],
    ["http://buy.stripe.com/abc", null],
    ["https://evil.example/https://buy.stripe.com/abc", null],
    ["https://buy.stripe.com.evil.example/abc", null],
    ["https://buy.stripe.com@evil.example/abc", null],
    ["https://user:pw@buy.stripe.com/abc", null],
    ["https://buy.stripe.com:8443/x", null],
    ["https://buy.stripe.com./x", null],
    ["https://buy.stripe.com\\@evil.example/x", null],
    ["https://buy.stripe.com", null],
    ["https://buy.stripe.com/", null],
    ["https://buy.stripe.com/a/b", null],
    ["https://buy.stripe.com/a?x=1", "https://buy.stripe.com/a?x=1"],
    ["https://ko" + "-fi.com/x", null],
    ["javascript:alert(1)", null],
    ["not a url", null],
    ["https://buy.stripe.com/abc", "https://buy.stripe.com/abc"],
    ["  https://buy.stripe.com/test_123  ", "https://buy.stripe.com/test_123"],
  ])("%j -> %j", (input, expected) => {
    expect(parseSupportLink(input)).toBe(expected);
  });
});
