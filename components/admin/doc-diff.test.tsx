import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { DocDiffView } from "./doc-diff";
import type { DiffEntry } from "@/lib/doc-diff";

describe("DocDiffView", () => {
  it("renders the empty state when given no entries", () => {
    render(<DocDiffView entries={[]} />);
    expect(screen.getByText("No field-level changes detected.")).toBeInTheDocument();
  });

  it("renders a Before/After row per entry, labeled by key", () => {
    const entries: DiffEntry[] = [
      { key: "status", before: "planned", after: "operational" },
    ];

    const { container } = render(<DocDiffView entries={entries} />);

    expect(screen.getByText("status")).toBeInTheDocument();
    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByText("After")).toBeInTheDocument();
    expect(screen.getByText("planned")).toBeInTheDocument();
    expect(screen.getByText("operational")).toBeInTheDocument();
    expect(container.querySelector("dl")).toBeInTheDocument();
    expect(container.querySelectorAll("dt")).toHaveLength(2);
  });

  it("renders one card per entry for multiple changed keys", () => {
    const entries: DiffEntry[] = [
      { key: "status", before: "planned", after: "operational" },
      { key: "operator", before: "Acme Co", after: "Beta LLC" },
    ];

    render(<DocDiffView entries={entries} />);

    expect(screen.getByText("status")).toBeInTheDocument();
    expect(screen.getByText("operator")).toBeInTheDocument();
    expect(screen.getByText("Acme Co")).toBeInTheDocument();
    expect(screen.getByText("Beta LLC")).toBeInTheDocument();
  });

  it("renders 'null' for a null before/after value and handles create/delete-shaped entries", () => {
    const entries: DiffEntry[] = [{ key: "name", before: null, after: "New Site" }];

    render(<DocDiffView entries={entries} />);

    expect(screen.getByText("null")).toBeInTheDocument();
    expect(screen.getByText("New Site")).toBeInTheDocument();
  });
});
