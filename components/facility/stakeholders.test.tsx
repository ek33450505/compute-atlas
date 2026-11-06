import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { StakeholdersSection, hasStakeholders, splitVoteDirection } from "./stakeholders";
import type { DataCenterFacility } from "@/lib/schema";
import { parseOperatorOwnership } from "@/lib/operator-ownership";

/** Minimal data-center Facility stub with required fields. */
function makeFacility(
  overrides: Partial<DataCenterFacility> = {}
): DataCenterFacility {
  return {
    id: "test-dc",
    name: "Test Datacenter",
    operator: "Test Corp",
    status: "operational",
    facilityType: "data_center",
    aiClassification: "confirmed",
    confidence: "confirmed",
    location: {
      lat: 40.0,
      lon: -90.0,
      city: "Springfield",
      state: "IL",
      precision: "exact",
    },
    statusHistory: [],
    sources: [
      {
        url: "https://example.com/founder-source",
        label: "Founder Filing",
        retrievedAt: "2024-01-01",
        kind: "filing",
      },
      {
        url: "https://example.com/official-source",
        label: "County Meeting Minutes",
        retrievedAt: "2024-02-01",
        kind: "other",
      },
    ],
    lastUpdated: "2024-06-01",
    ...overrides,
  };
}

describe("hasStakeholders", () => {
  it("returns false when the facility has no stakeholders", () => {
    expect(hasStakeholders(makeFacility())).toBe(false);
  });

  it("returns false when stakeholders is an empty array", () => {
    expect(hasStakeholders(makeFacility({ stakeholders: [] }))).toBe(false);
  });

  it("returns true when at least one stakeholder is present", () => {
    const facility = makeFacility({
      stakeholders: [
        { name: "Jane Doe", role: "founder", sourceIndex: 0, asOf: "2024-01-01" },
      ],
    });
    expect(hasStakeholders(facility)).toBe(true);
  });
});

describe("StakeholdersSection", () => {
  it("renders a SectionGapPrompt tip trigger when the facility has no stakeholders", () => {
    render(<StakeholdersSection facility={makeFacility()} />);

    const trigger = screen.getByRole("button");
    expect(trigger).toHaveTextContent(/a documented stakeholder/i);
    expect(
      screen.queryByRole("heading", { name: "Notable stakeholders" })
    ).not.toBeInTheDocument();
  });

  it("renders a financial-interest entry with its source link", () => {
    const facility = makeFacility({
      stakeholders: [
        {
          name: "Jane Doe",
          role: "founder",
          via: "Acme Holdings",
          note: "Co-founded the parent company.",
          sourceIndex: 0,
          asOf: "2024-01-01",
        },
      ],
    });
    render(<StakeholdersSection facility={facility} />);

    expect(
      screen.getByRole("heading", { name: "Notable stakeholders" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Ownership and financial interest" })
    ).toBeInTheDocument();
    expect(screen.getByText("Founder")).toBeInTheDocument();
    expect(screen.getByText("Jane Doe via Acme Holdings")).toBeInTheDocument();
    expect(
      screen.getByText("Co-founded the parent company.")
    ).toBeInTheDocument();
    expect(screen.getByText(/As of 2024-01-01/)).toBeInTheDocument();

    const link = screen.getByRole("link", {
      name: /Founder Filing \(opens in new tab\)/i,
    });
    expect(link).toHaveAttribute("href", "https://example.com/founder-source");
  });

  it("renders an organization lender under the financial-interest group with a Lender label", () => {
    const facility = makeFacility({
      stakeholders: [
        {
          name: "Example Credit Fund",
          kind: "organization",
          role: "lender",
          note: "Provided the construction loan for this campus.",
          sourceIndex: 0,
          asOf: "2024-01-01",
        },
      ],
    });
    render(<StakeholdersSection facility={facility} />);

    const financialHeading = screen.getByRole("heading", {
      name: "Ownership and financial interest",
    });
    const financialGroup = financialHeading.closest("div") as HTMLElement;
    expect(within(financialGroup).getByText("Lender")).toBeInTheDocument();
    expect(within(financialGroup).getByText("Example Credit Fund")).toBeInTheDocument();
  });

  it("renders the public-official group with its caption", () => {
    const facility = makeFacility({
      stakeholders: [
        {
          name: "Senator Smith",
          role: "public_official",
          note: "Voted to approve the rezoning.",
          sourceIndex: 1,
          asOf: "2024-02-01",
        },
      ],
    });
    render(<StakeholdersSection facility={facility} />);

    expect(
      screen.getByRole("heading", { name: "Public officials" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Officials with a documented role in this site.s approval or funding\. Listing here does not imply a financial interest\./
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Public official")).toBeInTheDocument();
    expect(screen.getByText("Senator Smith")).toBeInTheDocument();

    const link = screen.getByRole("link", {
      name: /County Meeting Minutes \(opens in new tab\)/i,
    });
    expect(link).toHaveAttribute(
      "href",
      "https://example.com/official-source"
    );
  });

  it("does not render a public_official entry under the financial-interest heading", () => {
    const facility = makeFacility({
      stakeholders: [
        {
          name: "Jane Doe",
          role: "founder",
          sourceIndex: 0,
          asOf: "2024-01-01",
        },
        {
          name: "Senator Smith",
          role: "public_official",
          sourceIndex: 1,
          asOf: "2024-02-01",
        },
      ],
    });
    render(<StakeholdersSection facility={facility} />);

    const financialHeading = screen.getByRole("heading", {
      name: "Ownership and financial interest",
    });
    const financialGroup = financialHeading.closest("div") as HTMLElement;
    expect(financialGroup).not.toBeNull();
    expect(within(financialGroup).getByText("Jane Doe")).toBeInTheDocument();
    expect(
      within(financialGroup).queryByText("Senator Smith")
    ).not.toBeInTheDocument();

    const officialsHeading = screen.getByRole("heading", {
      name: "Public officials",
    });
    const officialsGroup = officialsHeading.closest("div") as HTMLElement;
    expect(
      within(officialsGroup).queryByText("Jane Doe")
    ).not.toBeInTheDocument();
  });
});

describe("operator-level ownership", () => {
  const ownership = parseOperatorOwnership([
    {
      operator: "Test Corp",
      owners: [
        {
          name: "Example Capital",
          kind: "organization",
          role: "controlling_owner",
          since: "2021-08",
          note: "Acquired the operating company.",
          source: {
            url: "https://example.com/ownership-filing",
            label: "Acquisition filing",
            publisher: "Example Wire",
            retrievedAt: "2026-11-04",
            kind: "filing",
          },
          asOf: "2026-11-04",
        },
        {
          name: "Fixture Infra Partners",
          kind: "organization",
          parent: "Fixture Group",
          role: "investor",
          stakePct: 40,
          source: {
            url: "https://example.com/second",
            label: "Second filing",
            retrievedAt: "2026-11-04",
            kind: "filing",
          },
          asOf: "2026-11-04",
        },
      ],
    },
  ]);

  it("counts operator owners as having stakeholders, without making them site-level", () => {
    expect(hasStakeholders(makeFacility(), ownership)).toBe(true);
    expect(hasStakeholders(makeFacility({ operator: "Unowned Co" }), ownership)).toBe(false);
  });

  it("shows no gap prompt when only operator owners exist, and renders them under 'Through the operator'", () => {
    render(<StakeholdersSection facility={makeFacility()} ownership={ownership} />);

    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Ownership and financial interest" })).not.toBeInTheDocument();

    const heading = screen.getByRole("heading", { name: "Through the operator" });
    const group = heading.closest("div") as HTMLElement;
    expect(
      within(group).getByText(
        "Test Corp is owned as shown below. These stakes are held in the operating company, not documented for this site specifically."
      )
    ).toBeInTheDocument();
    expect(within(group).getByText("Controlling owner")).toBeInTheDocument();
    expect(within(group).getByText("Example Capital")).toBeInTheDocument();
    expect(within(group).getByText("since 2021-08")).toBeInTheDocument();
    expect(within(group).getByText("Acquired the operating company.")).toBeInTheDocument();
    expect(within(group).getAllByText("As of 2026-11-04")).toHaveLength(2);
    expect(within(group).getByText("Fixture Infra Partners (part of Fixture Group)")).toBeInTheDocument();
    expect(within(group).getByText("40% stake")).toBeInTheDocument();

    const link = within(group).getByRole("link", {
      name: /Acquisition filing, Example Wire \(opens in new tab\)/,
    });
    expect(link).toHaveAttribute("href", "https://example.com/ownership-filing");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("renders the operator group after the site-level groups", () => {
    const facility = makeFacility({
      stakeholders: [{ name: "Jane Doe", role: "founder", sourceIndex: 0, asOf: "2024-01-01" }],
    });
    render(<StakeholdersSection facility={facility} ownership={ownership} />);

    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(["Ownership and financial interest", "Through the operator"]);
  });

  it("omits the operator group when the operator has no owners", () => {
    const facility = makeFacility({
      stakeholders: [{ name: "Jane Doe", role: "founder", sourceIndex: 0, asOf: "2024-01-01" }],
    });
    render(<StakeholdersSection facility={facility} ownership={[]} />);

    expect(screen.queryByRole("heading", { name: "Through the operator" })).not.toBeInTheDocument();
  });

  it("treats an absent ownership prop as an empty layer (never reads a bundled snapshot)", () => {
    // "QTS Data Centers" has a row in the bundled snapshot; the component must not look it up.
    const facility = makeFacility({
      operator: "QTS Data Centers",
      stakeholders: [{ name: "Jane Doe", role: "founder", sourceIndex: 0, asOf: "2024-01-01" }],
    });
    render(<StakeholdersSection facility={facility} />);

    expect(screen.getByRole("heading", { name: "Ownership and financial interest" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Through the operator" })).not.toBeInTheDocument();
    expect(hasStakeholders(makeFacility({ operator: "QTS Data Centers" }))).toBe(false);
  });
});

describe("splitVoteDirection", () => {
  const dir = (note: string) => splitVoteDirection(note)?.direction ?? null;

  it("finds the direction word for each vote shape", () => {
    expect(dir("Member of the Westfield City Council; voted against the project application. Outcome: passed 10-3.")).toBe("against");
    expect(dir("Mayor of Buckeye; voted for Ordinance No. 08-24. Outcome: passed unanimously.")).toBe("for");
    expect(dir("Board: voted no on the motion to approve a tax exemption; motion carried 3-1.")).toBe("no");
    expect(dir("Board: abstained; minutes: Garczyk and Kelly abstaining.")).toBe("abstained");
  });

  it("matches only the first vote, not the body's tally", () => {
    const note = "present per the roll call and voted yes; minutes: motion carried 4-0, all present voted yes.";
    const split = splitVoteDirection(note);
    expect(split?.direction).toBe("yes");
    expect(split?.before).toBe("present per the roll call and voted ");
    expect(split?.after).toContain("all present voted yes.");
    expect(`${split?.before}${split?.direction}${split?.after}`).toBe(note);
  });

  it("returns null without a vote or on partial words", () => {
    // Deliberate: a seconder note never states the person's own vote; "voting yes"
    // describes all present, so it must not be bolded from the body's tally.
    expect(splitVoteDirection("seconded the motion; carried 4-0, all present voting yes per the minutes.")).toBeNull();
    expect(splitVoteDirection("Called the special session.")).toBeNull();
    expect(splitVoteDirection("Voted forward the item; voted noted.")).toBeNull();
  });
});

describe("vote direction emphasis", () => {
  function renderOfficial(note: string, role: "public_official" | "investor" = "public_official") {
    render(
      <StakeholdersSection
        facility={makeFacility({
          stakeholders: [{ name: "Jane Doe", role, note, sourceIndex: 1, asOf: "2024-02-01" }],
        })}
      />
    );
  }

  it("bolds only the first direction and keeps the text identical", () => {
    const note = "Authority meeting: present and voted yes; minutes: carried 4-0, all present voted yes.";
    renderOfficial(note);
    const strong = screen.getByText("yes", { selector: "strong" });
    expect(document.querySelectorAll("strong")).toHaveLength(1);
    expect(strong.parentElement?.textContent).toBe(note);
  });

  it("bolds abstained and leaves abstaining plain", () => {
    renderOfficial("Meeting: abstained; minutes: Kelly abstaining.");
    expect(screen.getByText("abstained", { selector: "strong" })).toBeInTheDocument();
    expect(document.querySelectorAll("strong")).toHaveLength(1);
  });

  it("does not bold notes without a vote", () => {
    // Deliberate: no direction word ("voted for/against/yes/no"), so intentionally plain.
    renderOfficial("Voted to approve the rezoning.");
    expect(document.querySelectorAll("strong")).toHaveLength(0);
  });

  it("leaves financial-role notes unchanged", () => {
    renderOfficial("Investor who voted for the plan.", "investor");
    expect(document.querySelectorAll("strong")).toHaveLength(0);
  });
});
