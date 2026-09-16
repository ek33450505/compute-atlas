import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SectionHeading } from "./section-heading";

describe("SectionHeading", () => {
  it("renders the kicker with the § prefix prepended", () => {
    render(<SectionHeading kicker="By type" id="facility-type-heading" title="Facility type" />);
    expect(screen.getByText("§ By type")).toBeInTheDocument();
  });

  it("renders an h2 with the given id, canonical classes, and title text", () => {
    render(<SectionHeading kicker="By status" id="status-heading" title="Lifecycle status" />);
    const heading = screen.getByRole("heading", { level: 2, name: "Lifecycle status" });
    expect(heading).toHaveAttribute("id", "status-heading");
    expect(heading).toHaveClass("font-display", "text-2xl", "text-foreground");
  });

  // ── size ───────────────────────────────────────────────────────────────
  // `size` was added for the homepage's louder display step. The default
  // branch has to stay BYTE-identical because ~40 call sites across 10 lens
  // and collection pages render it and none of them pass the prop.
  it("defaults to the text-2xl step, class-for-class as before the prop existed", () => {
    render(<SectionHeading kicker="By type" id="type-heading" title="Facility type" />);
    const heading = screen.getByRole("heading", { level: 2, name: "Facility type" });
    // The exact attribute, not toHaveClass: a stray extra class (or a changed
    // order) is exactly the regression the 40 unmigrated call sites would show
    // and this suite would otherwise wave through.
    expect(heading.getAttribute("class")).toBe("font-display text-2xl text-foreground");
  });

  it("renders the explicit default identically to the omitted one", () => {
    // Both halves must use the SAME id for innerHTML equality to mean anything
    // — but two nodes with one id in a single document make aria-labelledby
    // resolution ambiguous, which is precisely the bug the region-name tests in
    // this file and in components/home/*.test.tsx exist to catch. So render
    // into DETACHED containers: RTL only auto-appends the container it creates
    // itself, so these never enter document.body and the id is never duplicated
    // in the document under test.
    const { container: omitted } = render(
      <SectionHeading kicker="By type" id="default-parity" title="Facility type" />,
      { container: document.createElement("div") }
    );
    const { container: explicit } = render(
      <SectionHeading kicker="By type" id="default-parity" size="default" title="Facility type" />,
      { container: document.createElement("div") }
    );
    expect(explicit.innerHTML).toBe(omitted.innerHTML);
  });

  it('renders the larger responsive step for size="lg"', () => {
    render(
      <SectionHeading kicker="What it takes" id="cost-heading" size="lg" title="The other side of the ledger" />
    );
    const heading = screen.getByRole("heading", {
      level: 2,
      name: "The other side of the ledger",
    });
    expect(heading).toHaveClass("font-display", "text-3xl", "sm:text-4xl", "text-foreground");
    // The step it replaced must be gone, not merely joined — two size
    // utilities on one element is a cascade coin-flip, not a bigger heading.
    expect(heading).not.toHaveClass("text-2xl");
  });

  it("keeps the § prefix and the id contract at the lg step too", () => {
    // The prop changes one utility and nothing else; asserting that here
    // means a future size branch cannot quietly drop the kicker or the id.
    render(
      <section aria-labelledby="ways-in-heading">
        <SectionHeading kicker="Explore the atlas" id="ways-in-heading" size="lg" title="Find your way in" />
      </section>
    );
    expect(screen.getByText("§ Explore the atlas")).toBeInTheDocument();
    const region = screen.getByRole("region", { name: "Find your way in" });
    expect(region.querySelector("h2")).toHaveAttribute("id", "ways-in-heading");
  });

  it("accepts non-string ReactNode for kicker and title", () => {
    render(
      <SectionHeading
        kicker="Facilities"
        id="facilities-heading"
        title={<>Facilities in <span>Texas</span></>}
      />
    );
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Facilities in Texas");
    expect(screen.getByText("Texas")).toBeInTheDocument();
  });

  it("keeps the h2 id and the wrapping section's aria-labelledby in sync (a11y contract)", () => {
    render(
      <section aria-labelledby="community-heading">
        <SectionHeading kicker="Community reception" id="community-heading" title="Community reception" />
      </section>
    );
    // A section is only exposed as an accessible "region" when it has a name
    // (aria-labelledby resolving to an in-document heading is what supplies
    // that name) — so finding it by role+name proves the id/aria-labelledby
    // pairing actually resolves, not just that both strings happen to match.
    const region = screen.getByRole("region", { name: "Community reception" });
    expect(region.tagName).toBe("SECTION");
  });
});
