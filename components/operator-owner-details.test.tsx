import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { OperatorOwnerDetails, ownerDisplayName } from "@/components/operator-owner-details";
import {
  loadOperatorOwnershipUncached,
  parseOperatorOwnership,
  type OperatorOwnershipSource,
} from "@/lib/operator-ownership";

const ROWS = parseOperatorOwnership([
  {
    operator: "Fixture Cloud",
    owners: [
      {
        name: "Fixture Infra",
        kind: "organization",
        parent: "Fixture Group",
        role: "investor",
        stakePct: 40,
        since: "2022-05",
        note: "Holds a minority stake in the operating company.",
        source: {
          url: "https://example.com/filing",
          label: "Example filing",
          publisher: "Example Wire",
          retrievedAt: "2026-11-04",
          kind: "filing",
        },
        asOf: "2026-11-04",
      },
    ],
  },
]);

// Rows keyed by operator_key, as the Neon table is.
function sourceOf(rows: Map<string, unknown>): OperatorOwnershipSource {
  return { one: async (operator) => rows.get(operator), all: async () => [...rows.values()] };
}

describe("OperatorOwnerDetails fed by the Neon loader", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://fake");
    vi.stubEnv("VERCEL_ENV", "production");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renders the stake, note, as-of date and source for a fixture operator", async () => {
    const rows = new Map(ROWS.map((r) => [r.operator, r]));
    const [row] = await loadOperatorOwnershipUncached("Fixture Cloud", sourceOf(rows));
    expect(row.owners).toHaveLength(1);

    expect(ownerDisplayName(row.owners[0])).toBe("Fixture Infra (part of Fixture Group)");
    render(<OperatorOwnerDetails owner={row.owners[0]} />);
    expect(screen.getByText("40% stake · since 2022-05")).toBeInTheDocument();
    expect(screen.getByText("Holds a minority stake in the operating company.")).toBeInTheDocument();
    expect(screen.getByText("As of 2026-11-04")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Example filing, Example Wire/ })).toHaveAttribute(
      "href",
      "https://example.com/filing"
    );
  });
});
