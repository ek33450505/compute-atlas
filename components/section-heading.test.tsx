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
