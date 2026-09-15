import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LensGateway, type LensGatewayProps } from "./lens-gateway";

const PROPS: LensGatewayProps = {
  counts: {
    sites: 1095,
    states: 45,
    includesDc: false,
    stateCodes: ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VA", "VT"],
    utilityLinked: 307,
    frictionCount: 153,
    aiClassified: 347,
    operators: 210,
    plannedGw: 40,
    cryptoCount: 62,
    metros: 27,
    counties: 636,
  },
};

describe("LensGateway", () => {
  it("renders all 10 lens links with the correct hrefs", () => {
    render(<LensGateway {...PROPS} />);

    const expected: [RegExp, string][] = [
      [/Map/, "/map"],
      [/By state/, "/states"],
      [/By metro/, "/metros"],
      [/Counties/, "/counties"],
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
    expect(screen.getByText("27 metros")).toBeInTheDocument();
    expect(screen.getByText("636 counties")).toBeInTheDocument();
  });

  // Regression guard, measured 2026-09-15: /counties was reachable only
  // from /explore (itself averaging search position 60.5) and Google had never
  // crawled it, so the 636 county hubs behind it inherited no link equity.
  // /metros had a footer link only. Both now carry a homepage link; deleting
  // either LENSES entry must fail here, not silently cost crawl budget again.
  it("links the county and metro hubs directly from the homepage gateway", () => {
    render(<LensGateway {...PROPS} />);

    expect(
      screen.getByRole("link", { name: /Counties/ })
    ).toHaveAttribute("href", "/counties");
    expect(
      screen.getByRole("link", { name: /By metro/ })
    ).toHaveAttribute("href", "/metros");
  });

  it("counts itself correctly in the section subheading", () => {
    render(<LensGateway {...PROPS} />);

    // Derived from LENSES.length, so this fails if an entry is added or
    // removed without the copy following it.
    expect(
      screen.getByText("10 lenses on the same source-cited dataset.")
    ).toBeInTheDocument();
  });

  it("phrases the By-state stat as '50 states and DC' when the dataset includes DC", () => {
    render(
      <LensGateway
        {...PROPS}
        counts={{ ...PROPS.counts, states: 51, includesDc: true, stateCodes: ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DC", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VA", "VT", "WA", "WI", "WV", "WY"] }}
      />
    );

    // Mutation coverage: reverting the stat back to a bare
    // `${c.states} states` template renders "51 states" instead — this
    // assertion only passes against statesPhrase's DC-aware wording.
    expect(screen.getByText("50 states and DC")).toBeInTheDocument();
    expect(screen.queryByText("51 states")).not.toBeInTheDocument();
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
