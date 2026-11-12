"use client";

import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { FilterBar } from "./filter-bar";
import { normalizeQuery } from "@/lib/explorer-params";
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
  facilityType: "data_center",
  aiClassification: "confirmed",
  confidence: "confirmed",
  location: { lat: 35.0, lon: -90.0, city: "Memphis", state: "TN", precision: "exact" },
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
  facilityType: "data_center",
  aiClassification: "likely",
  confidence: "reported",
  location: { lat: 30.0, lon: -97.0, city: "Austin", state: "TX", precision: "exact" },
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
  facilityType: "data_center",
  aiClassification: "confirmed",
  confidence: "rumored",
  location: { lat: 38.0, lon: -77.0, city: "Reston", state: "VA", precision: "exact" },
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
  facilityType: "data_center",
  aiClassification: "confirmed",
  confidence: "confirmed",
  location: { lat: 40.0, lon: -74.0, city: "Newark", state: "NJ", precision: "exact" },
  capacityMw: { operational: 50 },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2023-12-01",
};

const facilityE: Facility = {
  id: "fac-e",
  name: "Epsilon Power Plant",
  operator: "EpsilonPower",
  status: "operational",
  facilityType: "power_generation",
  confidence: "confirmed",
  location: { lat: 32.0, lon: -93.0, city: "Shreveport", state: "LA", precision: "exact" },
  capacityMw: { operational: 200 },
  statusHistory: [],
  sources: [makeSource()],
  lastUpdated: "2025-01-20",
};

const fixtures: Facility[] = [facilityA, facilityB, facilityC, facilityD, facilityE];
// Derived options from fixtures:
// States (sorted): LA, NJ, TN, TX, VA
// Operators (sorted): AlphaCorp, BetaInc, EpsilonPower, GammaTech
// Facility types: data_center, power_generation

// ---------------------------------------------------------------------------
// Types mirroring FilterBar internals
// ---------------------------------------------------------------------------

interface FilterValues {
  status: Status[];
  state: string[];
  operator: string[];
  facilityType: Facility["facilityType"][];
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
    setFacilityType: vi.fn(),
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
    facilityType: [],
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
    setFacilityType: (v: Facility["facilityType"][]) => {
      setValues((prev) => ({ ...prev, facilityType: v }));
      mocks.setFacilityType(v);
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
// Facility type facet popover
// ---------------------------------------------------------------------------

describe("FilterBar — Facility type facet", () => {
  it("opening the Type popover and checking a box calls setFacilityType with the added value", async () => {
    const user = userEvent.setup();
    const { mocks } = renderFilterBar();

    const trigger = screen.getByRole("button", { name: "Type" });
    await user.click(trigger);

    expect(screen.getByLabelText("Type filter options")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Power generation" }));

    expect(mocks.setFacilityType).toHaveBeenCalledWith(["power_generation"]);
  });

  it("unchecking a selected facility type calls setFacilityType with the value removed", async () => {
    const user = userEvent.setup();
    const { mocks } = renderFilterBar({ facilityType: ["power_generation"] });

    const trigger = screen.getByRole("button", { name: "Type (1 selected)" });
    await user.click(trigger);

    const checkbox = screen.getByRole("checkbox", { name: "Power generation" });
    expect(checkbox).toBeChecked();
    await user.click(checkbox);

    expect(mocks.setFacilityType).toHaveBeenCalledWith([]);
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

  it("explains that planned capacity counts, and describes the radio group with it", async () => {
    const user = userEvent.setup();
    renderFilterBar();

    await user.click(screen.getByRole("button", { name: "Capacity" }));

    const hint = "Includes planned capacity where it is larger than operational.";
    expect(screen.getByText(hint)).toBeVisible();
    expect(
      screen.getByRole("group", { name: "Minimum capacity" })
    ).toHaveAccessibleDescription(hint);
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
    expect(mocks.setFacilityType).toHaveBeenCalledWith([]);
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

// ---------------------------------------------------------------------------
// Table mode — server options + debounced search
// ---------------------------------------------------------------------------

describe("FilterBar — options prop and search", () => {
  const noop = () => {};
  const setters = {
    setStatus: noop,
    setState: noop,
    setOperator: noop,
    setFacilityType: noop,
    setMinMw: noop,
  };
  const values = { status: [], state: [], operator: [], facilityType: [], minMw: 0 } as FilterValues;

  it("uses precomputed options instead of deriving them from facilities", async () => {
    const user = userEvent.setup();
    render(
      <FilterBar
        options={{ statuses: ["operational"], states: ["ZZ"], operators: ["Zed"], facilityTypes: ["data_center"], maxMw: 0 }}
        values={values}
        setters={setters}
      />
    );
    await user.click(screen.getByRole("button", { name: "State" }));
    expect(screen.getByRole("checkbox", { name: "ZZ" })).toBeInTheDocument();
  });

  it("debounces the labelled search input", () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      render(
        <FilterBar
          options={{ statuses: [], states: [], operators: [], facilityTypes: [], maxMw: 0 }}
          values={values}
          setters={setters}
          search={{ value: "", onChange }}
        />
      );
      const input = screen.getByRole("searchbox", { name: "Search" });
      fireEvent.change(input, { target: { value: "ab" } });
      fireEvent.change(input, { target: { value: "abc" } });
      vi.advanceTimersByTime(299);
      expect(onChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith("abc");
    } finally {
      vi.useRealTimers();
    }
  });

  describe("search draft", () => {
    const OPTS = { statuses: [], states: [], operators: [], facilityTypes: [], maxMw: 0 };
    function Harness({ initial = "", echo = (v: string) => v }: { initial?: string; echo?: (v: string) => string }) {
      const [q, setQ] = useState(initial);
      return (
        <FilterBar
          options={OPTS}
          values={values}
          setters={setters}
          // echo mimics the server: trimmed value comes back through the URL
          search={{ value: q, onChange: (v) => setQ(echo(v)) }}
        />
      );
    }
    const box = () => screen.getByRole("searchbox", { name: "Search" }) as HTMLInputElement;
    const type = (v: string) => {
      box().focus();
      fireEvent.change(box(), { target: { value: v } });
    };
    const withTimers = (fn: () => void) => {
      vi.useFakeTimers();
      try {
        fn();
      } finally {
        vi.useRealTimers();
      }
    };

    it("keeps a trailing space when the trimmed value echoes back", () =>
      withTimers(() => {
        render(<Harness echo={normalizeQuery} />);
        type("Equinix ");
        act(() => { vi.advanceTimersByTime(300); });
        expect(box().value).toBe("Equinix ");
      }));

    it("never overwrites text typed while focused, even if the URL value changes mid-typing", () =>
      withTimers(() => {
        const onChange = vi.fn();
        const props = { options: OPTS, values, setters };
        const { rerender } = render(<FilterBar {...props} search={{ value: "", onChange }} />);
        type("Equi");
        // a stale echo of an earlier emission lands while the user is still typing
        rerender(<FilterBar {...props} search={{ value: "Eq", onChange }} />);
        expect(box().value).toBe("Equi");
      }));

    it("follows an external URL change while the input is not focused", () => {
      const onChange = vi.fn();
      const props = { options: OPTS, values, setters };
      const { rerender } = render(<FilterBar {...props} search={{ value: "a", onChange }} />);
      rerender(<FilterBar {...props} search={{ value: "b", onChange }} />);
      expect(box().value).toBe("b");
    });

    it("reconciles to the URL value on blur once nothing is pending", () =>
      withTimers(() => {
        render(<Harness echo={normalizeQuery} />);
        type("abc ");
        act(() => { vi.advanceTimersByTime(300); });
        act(() => { box().blur(); });
        expect(box().value).toBe("abc");
      }));

    it("blur with a pending debounce settles on the trimmed URL value", () =>
      withTimers(() => {
        render(<Harness initial="dallas" echo={normalizeQuery} />);
        type("dallas ");
        act(() => { box().blur(); });
        act(() => { vi.advanceTimersByTime(1000); });
        expect(box().value).toBe("dallas");
      }));

    it("Clear search with a pending debounce writes only the empty value", () => {
      vi.useFakeTimers();
      try {
        const onChange = vi.fn();
        render(<FilterBar options={OPTS} values={values} setters={setters} search={{ value: "", onChange }} />);
        type("abc");
        const btn = screen.getByRole("button", { name: "Clear search" });
        // jsdom has no default mousedown focus change: mimic the browser, which
        // blurs the input unless mousedown is default-prevented
        if (fireEvent.mouseDown(btn)) act(() => { box().blur(); });
        fireEvent.click(btn);
        act(() => { vi.advanceTimersByTime(1000); });
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith("");
      } finally {
        vi.useRealTimers();
      }
    });

    it("emits through the latest onChange, not the one from when typing started", () =>
      withTimers(() => {
        const first = vi.fn();
        const second = vi.fn();
        const props = { options: OPTS, values, setters };
        const { rerender } = render(<FilterBar {...props} search={{ value: "", onChange: first }} />);
        type("abc");
        rerender(<FilterBar {...props} search={{ value: "", onChange: second }} />);
        act(() => { vi.advanceTimersByTime(300); });
        expect(second).toHaveBeenCalledWith("abc");
        expect(first).not.toHaveBeenCalled();
      }));

    it("Clear all within the debounce window leaves q empty after timers run", () =>
      withTimers(() => {
        const onChange = vi.fn();
        render(<FilterBar options={OPTS} values={values} setters={setters} search={{ value: "", onChange }} />);
        type("abc");
        fireEvent.click(screen.getByRole("button", { name: /clear all/i }));
        act(() => { vi.advanceTimersByTime(1000); });
        expect(box().value).toBe("");
        expect(onChange).toHaveBeenLastCalledWith("");
        expect(onChange).not.toHaveBeenCalledWith("abc");
      }));

    it("Clear search empties the box and moves focus to it", () => {
      render(<Harness initial="abc" />);
      const btn = screen.getByRole("button", { name: "Clear search" });
      btn.focus();
      fireEvent.click(btn);
      expect(box().value).toBe("");
      expect(box()).toHaveFocus();
      expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();
    });
  });
});
