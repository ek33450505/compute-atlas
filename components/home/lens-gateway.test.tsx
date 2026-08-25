import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LensGateway, type LensGatewayProps } from "./lens-gateway";

const PROPS: LensGatewayProps = {
  counts: {
    sites: 1095,
    states: 45,
    utilityLinked: 307,
    frictionCount: 153,
    aiClassified: 347,
    operators: 210,
    plannedGw: 40,
    cryptoCount: 62,
  },
};

describe("LensGateway", () => {
  it("renders all 8 lens links with the correct hrefs", () => {
    render(<LensGateway {...PROPS} />);

    const expected: [RegExp, string][] = [
      [/Map/, "/map"],
      [/By state/, "/states"],
      [/Power & energy/, "/power"],
      [/Opposition/, "/opposition"],
      [/AI data centers/, "/ai"],
      [/Operators/, "/operators"],
      [/Rankings/, "/rankings"],
      [/Crypto mining/, "/crypto"],
    ];

    for (const [name, href] of expected) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("href", href);
    }
  });

  it("renders the passed counts in each card's stat text", () => {
    render(<LensGateway {...PROPS} />);

    expect(screen.getByText("1,095 sites")).toBeInTheDocument();
    expect(screen.getByText("45 states")).toBeInTheDocument();
    expect(screen.getByText("307 grid-linked")).toBeInTheDocument();
    expect(screen.getByText("153 in friction")).toBeInTheDocument();
    expect(screen.getByText("347 classified")).toBeInTheDocument();
    expect(screen.getByText("210 operators")).toBeInTheDocument();
    expect(screen.getByText("40 GW ranked")).toBeInTheDocument();
    expect(screen.getByText("62 sites")).toBeInTheDocument();
  });

  it("renders the two trailing links to /explore and /stats", () => {
    render(<LensGateway {...PROPS} />);

    const exploreLink = screen.getByRole("link", { name: /See every lens/ });
    expect(exploreLink).toHaveAttribute("href", "/explore");

    const statsLink = screen.getByRole("link", { name: /View full statistics/ });
    expect(statsLink).toHaveAttribute("href", "/stats");
  });

  it("hides every lens glyph from assistive tech (decorative)", () => {
    const { container } = render(<LensGateway {...PROPS} />);

    // No icon is exposed with an accessible img/graphics role.
    expect(screen.queryAllByRole("img")).toHaveLength(0);

    const icons = container.querySelectorAll("svg");
    expect(icons.length).toBeGreaterThan(0);
    icons.forEach((icon) => {
      expect(icon).toHaveAttribute("aria-hidden", "true");
    });
  });

  it("renders as a labeled region with a single heading, and passes through className", () => {
    render(<LensGateway {...PROPS} className="mt-2" />);

    const section = screen.getByRole("region", { name: "Find your way in" });
    expect(section).toHaveClass("mt-2");
    expect(
      screen.getByRole("heading", { level: 2, name: "Find your way in" })
    ).toBeInTheDocument();
  });
});
