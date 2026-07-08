"use client";

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { FilterBar } from "./filter-bar";
import type { Facility } from "@/lib/schema";
import type { Status } from "@/lib/status";

// ---------------------------------------------------------------------------
// Fixtures — 4 records spanning 4 states (NJ, TN, TX, VA) and 3 operators
// ---------------------------------------------------------------------------

function makeSource() {
  return {
    url: "https://example.com",
    label: "Example Source",
    retrievedAt: "2024-01-01",
    kind: "press" as const,
  };
}

const facilityA: Facility = {
  id: "fac-a",
  name: "Alpha Datacenter",
  operator: "AlphaCorp",
  status: "operational",
  aiClassification: "confirmed",
  confidence: "confirmed",
  location: { lat: 35.0, lon: -90.0, city: "Memphis", state: "TN" },
  capacityMw: { operational: 150 },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2024-01-01",
};

const facilityB: Facility = {
  id: "fac-b",
  name: "Beta Farm",
  operator: "BetaInc",
  status: "proposed",
  aiClassification: "likely",
  confidence: "reported",
  location: { lat: 30.0, lon: -97.0, city: "Austin", state: "TX" },
  capacityMw: { planned: 1200 },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2024-06-01",
};

const facilityC: Facility = {
  id: "fac-c",
  name: "Gamma Hub",
  operator: "GammaTech",
  status: "under_construction",
  aiClassification: "confirmed",
  confidence: "rumored",
  location: { lat: 38.0, lon: -77.0, city: "Reston", state: "VA" },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2025-01-15",
};

const facilityD: Facility = {
  id: "fac-d",
  name: "Delta Node",
  // Shares operator with A (≥2 states covered by AlphaCorp)
  operator: "AlphaCorp",
  status: "cancelled",
  aiClassification: "confirmed",
  confidence: "confirmed",
  location: { lat: 40.0, lon: -74.0, city: "Newark", state: "NJ" },
  capacityMw: { operational: 50 },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2023-12-01",
};

const fixtures: Facility[] = [facilityA, facilityB, facilityC, facilityD];
// Derived options from fixtures:
// States (sorted): NJ, TN, TX, VA
// Operators (sorted): AlphaCorp, BetaInc, GammaTech

// ---------------------------------------------------------------------------
// Types mirroring FilterBar internals
// ---------------------------------------------------------------------------

interface FilterValues {
  status: Status[];
  state: string[];
  operator: string[];
  minMw: number;
}

// ---------------------------------------------------------------------------
// Mocks factory + controlled wrapper
// ---------------------------------------------------------------------------

function makeMocks() {
  return {
    setStatus: vi.fn(),
    setState: vi.fn(),
    setOperator: vi.fn(),
    setMinMw: vi.fn(),
  };
}

type Mocks = ReturnType<typeof makeMocks>;

/**
 * Controlled wrapper that keeps real state (so the UI re-renders on setter
 * calls) and also forwards calls to vi.fn() spies for assertions.
 */
function ControlledFilterBar({
  initial = {},
  mocks,
}: {
  initial?: Partial<FilterValues>;
  mocks: Mocks;
}) {
  const [values, setValues] = useState<FilterValues>({
    status: [],
    state: [],
    operator: [],
    minMw: 0,
    ...initial,
  });

  const setters = {
    setStatus: (v: Status[]) => {
      setValues((prev) => ({ ...prev, status: v }));
      mocks.setStatus(v);
    },
    setState: (v: string[]) => {
      setValues((prev) => ({ ...prev, state: v }));
      mocks.setState(v);
    },
    setOperator: (v: string[]) => {
      setValues((prev) => ({ ...prev, operator: v }));
      mocks.setOperator(v);
    },
    setMinMw: (v: number) => {
      setValues((prev) => ({ ...prev, minMw: v }));
      mocks.setMinMw(v);
    },
  };

  return <FilterBar facilities={fixtures} values={values} setters={setters} />;
}

function renderFilterBar(initial: Partial<FilterValues> = {}) {
  const mocks = makeMocks();
  const result = render(<ControlledFilterBar initial={initial} mocks={mocks} />);
  return { ...result, mocks };
}

// ---------------------------------------------------------------------------
// State facet popover
// ---------------------------------------------------------------------------

describe("FilterBar — State facet", () => {
  it("opening the State popover and checking a box calls setState with the added value", async () => {
    const user = userEvent.setup();
    const { mocks } = renderFilterBar();

    // Trigger initially shows "State" (no count)
    const trigger = screen.getByRole("button", { name: "State" });
    await user.click(trigger);

    // Popover content is visible
    expect(screen.getByLabelText("State filter options")).toBeInTheDocument();

    // Toggle TX checkbox (adds it) — use getByRole to skip the aria-hidden hidden input
    const txCheckbox = screen.getByRole("checkbox", { name: "TX" });
    await user.click(txCheckbox);

    expect(mocks.setState).toHaveBeenCalledWith(["TX"]);
  });

  it("popover trigger shows active count badge after a state is selected", async () => {
    const user = userEvent.setup();
    renderFilterBar();

    const trigger = screen.getByRole("button", { name: "State" });
    await user.click(trigger);

    await user.click(screen.getByRole("checkbox", { name: "TX" }));

    // After selection, trigger label includes the count
    expect(
      screen.getByRole("button", { name: "State (1 selected)" })
    ).toBeInTheDocument();
  });

  it("unchecking a selected state calls setState with the value removed", async () => {
    const user = userEvent.setup();
    const { mocks } = renderFilterBar({ state: ["TX"] });

    // Trigger shows count
    const trigger = screen.getByRole("button", { name: "State (1 selected)" });
    await user.click(trigger);

    // TX checkbox is checked — click to remove
    const txCheckbox = screen.getByRole("checkbox", { name: "TX" });
    expect(txCheckbox).toBeChecked();
    await user.click(txCheckbox);

    expect(mocks.setState).toHaveBeenCalledWith([]);
  });
});

// ---------------------------------------------------------------------------
// Operator facet popover
// ---------------------------------------------------------------------------

describe("FilterBar — Operator facet", () => {
  it("opening the Operator popover and checking a box calls setOperator with the added value", async () => {
    const user = userEvent.setup();
    const { mocks } = renderFilterBar();

    const trigger = screen.getByRole("button", { name: "Operator" });
    await user.click(trigger);

    expect(screen.getByLabelText("Operator filter options")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "BetaInc" }));

    expect(mocks.setOperator).toHaveBeenCalledWith(["BetaInc"]);
  });

  it("unchecking a selected operator calls setOperator with the value removed", async () => {
    const user = userEvent.setup();
    const { mocks } = renderFilterBar({ operator: ["BetaInc"] });

    const trigger = screen.getByRole("button", { name: "Operator (1 selected)" });
    await user.click(trigger);

    const checkbox = screen.getByRole("checkbox", { name: "BetaInc" });
    expect(checkbox).toBeChecked();
    await user.click(checkbox);

    expect(mocks.setOperator).toHaveBeenCalledWith([]);
  });
});

// ---------------------------------------------------------------------------
// Capacity popover — single-select minimum
// ---------------------------------------------------------------------------

describe("FilterBar — Capacity popover", () => {
  it("clicking the Capacity trigger opens the popover", async () => {
    const user = userEvent.setup();
    renderFilterBar();

    const trigger = screen.getByRole("button", { name: "Capacity" });
    await user.click(trigger);

    expect(screen.getByLabelText("Minimum capacity options")).toBeInTheDocument();
  });

  it("selecting ≥100 MW calls setMinMw with 100 and closes the popover", async () => {
    const user = userEvent.setup();
    const { mocks } = renderFilterBar();

    const trigger = screen.getByRole("button", { name: "Capacity" });
    await user.click(trigger);

    const radio = screen.getByLabelText("≥100 MW");
    await user.click(radio);

    expect(mocks.setMinMw).toHaveBeenCalledWith(100);
    // Popover closes after selection
    expect(
      screen.queryByLabelText("Minimum capacity options")
    ).not.toBeInTheDocument();
  });

  it("trigger shows active badge when a non-zero capacity is set", () => {
    renderFilterBar({ minMw: 100 });

    // aria-label reflects the active state
    expect(
      screen.getByRole("button", { name: "Capacity (minimum ≥100 MW)" })
    ).toBeInTheDocument();
  });

  it("trigger shows no badge when capacity is Any (0)", () => {
    renderFilterBar({ minMw: 0 });

    expect(screen.getByRole("button", { name: "Capacity" })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Keyboard: Escape closes popover and returns focus to trigger
// ---------------------------------------------------------------------------

describe("FilterBar — Keyboard accessibility", () => {
  it("pressing Escape closes an open popover and returns focus to its trigger", async () => {
    const user = userEvent.setup();
    renderFilterBar();

    const trigger = screen.getByRole("button", { name: "State" });
    await user.click(trigger);

    // Popover is open
    expect(screen.getByLabelText("State filter options")).toBeInTheDocument();

    // Press Escape to close
    await user.keyboard("{Escape}");

    // Popover content is gone
    expect(
      screen.queryByLabelText("State filter options")
    ).not.toBeInTheDocument();

    // Focus returns to the trigger
    expect(document.activeElement).toBe(trigger);
  });
});

// ---------------------------------------------------------------------------
// Clear all
// ---------------------------------------------------------------------------

describe("FilterBar — Clear all", () => {
  it("Clear all button is absent when no filters are active", () => {
    renderFilterBar();
    expect(
      screen.queryByRole("button", { name: /clear all/i })
    ).not.toBeInTheDocument();
  });

  it("Clear all resets all setters when filters are active", async () => {
    const user = userEvent.setup();
    const { mocks } = renderFilterBar({
      state: ["TX"],
      operator: ["BetaInc"],
      minMw: 100,
    });

    const clearBtn = screen.getByRole("button", { name: /clear all/i });
    expect(clearBtn).toBeInTheDocument();

    await user.click(clearBtn);

    expect(mocks.setStatus).toHaveBeenCalledWith([]);
    expect(mocks.setState).toHaveBeenCalledWith([]);
    expect(mocks.setOperator).toHaveBeenCalledWith([]);
    expect(mocks.setMinMw).toHaveBeenCalledWith(0);
  });

  it("Clear all button disappears after clearing all filters", async () => {
    const user = userEvent.setup();
    renderFilterBar({ state: ["TX"] });

    const clearBtn = screen.getByRole("button", { name: /clear all/i });
    await user.click(clearBtn);

    expect(
      screen.queryByRole("button", { name: /clear all/i })
    ).not.toBeInTheDocument();
  });
});
