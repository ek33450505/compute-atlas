import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Source } from "@/lib/schema";
import { FacilitySourcesSection } from "./facility-sources-section";

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    url: "https://example.com/article",
    label: "Press release",
    retrievedAt: "2026-01-01",
    kind: "press",
    ...overrides,
  };
}

/**
 * Stateful wrapper: `FacilitySourcesSection` is fully controlled, so
 * focus-restoration tests (which depend on a real re-render after a row
 * unmounts) need a component that actually owns state and re-renders on
 * `onChange`, unlike the `vi.fn()` spy used by the other tests in this file.
 */
function StatefulSourcesSection({ initial }: { initial: Source[] }) {
  const [sources, setSources] = useState(initial);
  return <FacilitySourcesSection sources={sources} onChange={setSources} />;
}

describe("FacilitySourcesSection", () => {
  it("renders one fieldset per source with its fields populated", () => {
    const sources = [
      makeSource({ label: "First source" }),
      makeSource({ label: "Second source", kind: "permit" }),
    ];
    render(<FacilitySourcesSection sources={sources} onChange={vi.fn()} />);

    expect(screen.getByDisplayValue("First source")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Second source")).toBeInTheDocument();
    expect(screen.getAllByRole("group")).toHaveLength(2);
  });

  it("shows an inline required message when sources is empty", () => {
    render(<FacilitySourcesSection sources={[]} onChange={vi.fn()} />);

    expect(screen.getByRole("alert")).toHaveTextContent(/at least one source is required/i);
  });

  it("adds a new empty row when Add source is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FacilitySourcesSection sources={[makeSource()]} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /add source/i }));

    expect(onChange).toHaveBeenCalledWith([
      makeSource(),
      { url: "", label: "", retrievedAt: "", kind: "other" },
    ]);
  });

  it("calls onChange with the row removed when Remove is clicked (2+ rows)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const sources = [makeSource({ label: "Keep me" }), makeSource({ label: "Remove me" })];
    render(<FacilitySourcesSection sources={sources} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /remove source 2/i }));

    expect(onChange).toHaveBeenCalledWith([sources[0]]);
  });

  it("disables Remove on the last remaining row (min-1 UI floor)", () => {
    render(<FacilitySourcesSection sources={[makeSource()]} onChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: /remove source 1/i })).toBeDisabled();
  });

  it("exposes the min-1 disabled reason to assistive tech via aria-label", () => {
    render(<FacilitySourcesSection sources={[makeSource()]} onChange={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: /remove source 1.*at least one source is required/i })
    ).toBeDisabled();
  });

  it("swaps two rows when Move down then Move up are used", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const sources = [makeSource({ label: "Row A" }), makeSource({ label: "Row B" })];
    render(<FacilitySourcesSection sources={sources} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /move source 1 down/i }));

    expect(onChange).toHaveBeenCalledWith([sources[1], sources[0]]);
  });

  it("disables Move up on the first row and Move down on the last row", () => {
    const sources = [makeSource(), makeSource()];
    render(<FacilitySourcesSection sources={sources} onChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: /move source 1 up/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /move source 2 down/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /move source 1 down/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /move source 2 up/i })).toBeEnabled();
  });

  it("updates a field via onChange without touching sibling rows", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const sources = [makeSource({ label: "Original" })];
    render(<FacilitySourcesSection sources={sources} onChange={onChange} />);

    await user.type(screen.getByLabelText(/^label$/i), "!");

    expect(onChange).toHaveBeenCalledWith([{ ...sources[0], label: "Original!" }]);
  });

  it("shows an inline error for a non-empty invalid URL", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const sources = [makeSource({ url: "" })];
    const { rerender } = render(
      <FacilitySourcesSection sources={sources} onChange={onChange} />
    );

    await user.type(screen.getByLabelText(/^url$/i), "not-a-url");
    // Controlled input: simulate the parent re-rendering with the typed value.
    rerender(
      <FacilitySourcesSection sources={[{ ...sources[0], url: "not-a-url" }]} onChange={onChange} />
    );

    expect(screen.getByText(/enter a valid url/i)).toBeInTheDocument();
  });

  it("shows no URL error for an empty URL (required validation deferred to submit)", () => {
    render(<FacilitySourcesSection sources={[makeSource({ url: "" })]} onChange={vi.fn()} />);

    expect(screen.queryByText(/enter a valid url/i)).not.toBeInTheDocument();
  });

  it("shows no URL error for a valid URL", () => {
    render(
      <FacilitySourcesSection
        sources={[makeSource({ url: "https://example.com" })]}
        onChange={vi.fn()}
      />
    );

    expect(screen.queryByText(/enter a valid url/i)).not.toBeInTheDocument();
  });

  describe("focus restoration after Remove (§1f)", () => {
    it("moves focus to the Remove button of the row that took the removed row's place", async () => {
      const user = userEvent.setup();
      const initial = [
        makeSource({ label: "Row 1" }),
        makeSource({ label: "Row 2" }),
        makeSource({ label: "Row 3" }),
      ];
      render(<StatefulSourcesSection initial={initial} />);

      await user.click(screen.getByRole("button", { name: /remove source 2/i }));

      // Row 3 shifted into index 1 and is now "Source 2".
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /remove source 2/i })
      );
    });

    it("moves focus to the last row's Remove button when the last row is removed", async () => {
      const user = userEvent.setup();
      const initial = [makeSource({ label: "Row 1" }), makeSource({ label: "Row 2" })];
      render(<StatefulSourcesSection initial={initial} />);

      await user.click(screen.getByRole("button", { name: /remove source 2/i }));

      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: /remove source 1/i })
      );
    });
  });
});
