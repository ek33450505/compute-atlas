import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Source, Facility } from "@/lib/schema";
import { FacilityStatusHistorySection } from "./facility-status-history-section";

type StatusHistoryEntry = Facility["statusHistory"][number];

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    url: "https://example.com/article",
    label: "Press release",
    retrievedAt: "2026-01-01",
    kind: "press",
    ...overrides,
  };
}

function makeEntry(overrides: Partial<StatusHistoryEntry> = {}): StatusHistoryEntry {
  return {
    status: "proposed",
    date: "2026-01-01",
    ...overrides,
  };
}

/**
 * Stateful wrapper: `FacilityStatusHistorySection` is fully controlled, so
 * focus-restoration tests (which depend on a real re-render after a row
 * unmounts) need a component that actually owns state and re-renders on
 * `onChange`, unlike the `vi.fn()` spy used by the other tests in this file.
 */
function StatefulStatusHistorySection({ initial }: { initial: StatusHistoryEntry[] }) {
  const [statusHistory, setStatusHistory] = useState(initial);
  return (
    <FacilityStatusHistorySection
      statusHistory={statusHistory}
      sources={[]}
      onChange={setStatusHistory}
    />
  );
}

describe("FacilityStatusHistorySection", () => {
  it("shows an empty-state message when statusHistory is empty", () => {
    render(
      <FacilityStatusHistorySection statusHistory={[]} sources={[]} onChange={vi.fn()} />
    );

    expect(screen.getByText(/no status history entries/i)).toBeInTheDocument();
  });

  it("renders one fieldset per entry with its fields populated", () => {
    const statusHistory = [
      makeEntry({ status: "permitted", date: "2026-02-01", note: "First note" }),
      makeEntry({ status: "operational", date: "2026-03-01", note: "Second note" }),
    ];
    render(
      <FacilityStatusHistorySection statusHistory={statusHistory} sources={[]} onChange={vi.fn()} />
    );

    expect(screen.getByDisplayValue("First note")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Second note")).toBeInTheDocument();
    expect(screen.getAllByRole("group")).toHaveLength(2);
  });

  it("adds a new empty row when Add status history entry is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FacilityStatusHistorySection
        statusHistory={[makeEntry()]}
        sources={[]}
        onChange={onChange}
      />
    );

    await user.click(screen.getByRole("button", { name: /add status history entry/i }));

    expect(onChange).toHaveBeenCalledWith([makeEntry(), { status: "proposed", date: "" }]);
  });

  it("calls onChange with the row removed when Remove is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const statusHistory = [
      makeEntry({ note: "Keep me" }),
      makeEntry({ note: "Remove me" }),
    ];
    render(
      <FacilityStatusHistorySection
        statusHistory={statusHistory}
        sources={[]}
        onChange={onChange}
      />
    );

    await user.click(screen.getByRole("button", { name: /remove status history entry 2/i }));

    expect(onChange).toHaveBeenCalledWith([statusHistory[0]]);
  });

  it("allows removing the last remaining row (no min-1 floor, unlike sources)", () => {
    render(
      <FacilityStatusHistorySection
        statusHistory={[makeEntry()]}
        sources={[]}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /remove status history entry 1/i })).toBeEnabled();
  });

  it("swaps two rows when Move down is used", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const statusHistory = [makeEntry({ note: "Row A" }), makeEntry({ note: "Row B" })];
    render(
      <FacilityStatusHistorySection
        statusHistory={statusHistory}
        sources={[]}
        onChange={onChange}
      />
    );

    await user.click(screen.getByRole("button", { name: /move status history entry 1 down/i }));

    expect(onChange).toHaveBeenCalledWith([statusHistory[1], statusHistory[0]]);
  });

  it("disables Move up on the first row and Move down on the last row", () => {
    const statusHistory = [makeEntry(), makeEntry()];
    render(
      <FacilityStatusHistorySection
        statusHistory={statusHistory}
        sources={[]}
        onChange={vi.fn()}
      />
    );

    expect(
      screen.getByRole("button", { name: /move status history entry 1 up/i })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /move status history entry 2 down/i })
    ).toBeDisabled();
  });

  it("updates a field via onChange without touching sibling rows", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const statusHistory = [makeEntry({ note: "Original" })];
    render(
      <FacilityStatusHistorySection
        statusHistory={statusHistory}
        sources={[]}
        onChange={onChange}
      />
    );

    await user.type(screen.getByLabelText(/^note/i), "!");

    expect(onChange).toHaveBeenCalledWith([{ ...statusHistory[0], note: "Original!" }]);
  });

  it("passes the live sources array through to the sourceIndex picker", async () => {
    const user = userEvent.setup();
    const sources = [makeSource({ label: "Only source" })];
    render(
      <FacilityStatusHistorySection
        statusHistory={[makeEntry()]}
        sources={sources}
        onChange={vi.fn()}
      />
    );

    await user.click(screen.getByRole("combobox", { name: /^source/i }));

    // findByRole (async/polling), not getByRole: Base UI's Select popup
    // visibility is animation-gated and can resolve a tick after the click
    // even under jsdom — see facility-source-index-picker.test.tsx's header
    // comment for the full explanation.
    expect(await screen.findByRole("option", { name: /only source/i })).toBeInTheDocument();
  });

  it("sets sourceIndex via the picker without touching other fields", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const sources = [makeSource({ label: "Pick me" })];
    const statusHistory = [makeEntry({ note: "Keep this note" })];
    render(
      <FacilityStatusHistorySection
        statusHistory={statusHistory}
        sources={sources}
        onChange={onChange}
      />
    );

    await user.click(screen.getByRole("combobox", { name: /^source/i }));
    const pickMeOption = await screen.findByRole("option", { name: /pick me/i });
    await user.click(pickMeOption);

    expect(onChange).toHaveBeenCalledWith([{ ...statusHistory[0], sourceIndex: 0 }]);
  });

  describe("focus restoration after Remove (§1f)", () => {
    it("moves focus to the Remove button of the row that took the removed row's place", async () => {
      const user = userEvent.setup();
      const initial = [
        makeEntry({ note: "Row 1" }),
        makeEntry({ note: "Row 2" }),
        makeEntry({ note: "Row 3" }),
      ];
      render(<StatefulStatusHistorySection initial={initial} />);

      await user.click(screen.getByRole("button", { name: /remove status history entry 2/i }));

      // Row 3 shifted into index 1 and is now "entry 2".
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /remove status history entry 2/i })
      );
    });

    it("moves focus to the Add button when the only remaining row is removed", async () => {
      const user = userEvent.setup();
      render(<StatefulStatusHistorySection initial={[makeEntry()]} />);

      await user.click(screen.getByRole("button", { name: /remove status history entry 1/i }));

      expect(screen.getByText(/no status history entries/i)).toBeInTheDocument();
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /add status history entry/i })
      );
    });
  });
});
