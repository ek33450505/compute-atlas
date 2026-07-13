import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Source } from "@/lib/schema";
import { FacilitySourceIndexPicker } from "./facility-source-index-picker";

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    url: "https://example.com/article",
    label: "Press release",
    retrievedAt: "2026-01-01",
    kind: "press",
    ...overrides,
  };
}

// NOTE: option queries use `findByRole` (async, polling), not `getByRole`,
// right after opening the Select. Base UI's popup mount/visibility is
// animation-gated (useTransitionStatus/useAnimationsFinished) and its
// open-state can resolve a tick after the triggering click even in jsdom
// (no real CSS transitions) — asserting synchronously immediately after
// `user.click()` intermittently raced the popup becoming queryable across
// sequential tests in this file. `findByRole` waits for it.

describe("FacilitySourceIndexPicker", () => {
  it("renders a 'None' option plus one option per populated source", async () => {
    const user = userEvent.setup();
    const sources = [
      makeSource({ label: "First", kind: "press" }),
      makeSource({ label: "Second", kind: "permit" }),
    ];
    render(
      <FacilitySourceIndexPicker
        id="picker-1"
        label="Source"
        sources={sources}
        value={undefined}
        onChange={vi.fn()}
      />
    );

    await user.click(screen.getByRole("combobox", { name: /source/i }));

    expect(await screen.findByRole("option", { name: /none/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /press.*first/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /permit.*second/i })).toBeInTheDocument();
  });

  it("shows no source options when sources is empty", async () => {
    const user = userEvent.setup();
    render(
      <FacilitySourceIndexPicker
        id="picker-2"
        label="Source"
        sources={[]}
        value={undefined}
        onChange={vi.fn()}
      />
    );

    await user.click(screen.getByRole("combobox", { name: /source/i }));

    expect(await screen.findByRole("option", { name: /none/i })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("calls onChange with the selected index when a source option is picked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const sources = [makeSource({ label: "First" }), makeSource({ label: "Second" })];
    render(
      <FacilitySourceIndexPicker
        id="picker-3"
        label="Source"
        sources={sources}
        value={undefined}
        onChange={onChange}
      />
    );

    await user.click(screen.getByRole("combobox", { name: /source/i }));
    const secondOption = await screen.findByRole("option", { name: /second/i });
    await user.click(secondOption);

    expect(onChange).toHaveBeenCalledWith(1);
  });

  it("calls onChange with undefined when 'None' is picked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const sources = [makeSource()];
    render(
      <FacilitySourceIndexPicker
        id="picker-4"
        label="Source"
        sources={sources}
        value={0}
        onChange={onChange}
      />
    );

    await user.click(screen.getByRole("combobox", { name: /source/i }));
    const noneOption = await screen.findByRole("option", { name: /none/i });
    await user.click(noneOption);

    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it("does not select an out-of-range value, even if passed as the current value", async () => {
    const user = userEvent.setup();
    // Simulates the "stale reference" scenario: a row's sourceIndex (2)
    // pointed at a source that has since been removed, leaving only 1
    // source (index 0) in the live array. The picker must not crash or
    // silently render index-2's now-nonexistent label; it renders "None".
    render(
      <FacilitySourceIndexPicker
        id="picker-5"
        label="Source"
        sources={[makeSource()]}
        value={2}
        onChange={vi.fn()}
      />
    );

    await user.click(screen.getByRole("combobox", { name: /source/i }));

    expect(await screen.findByRole("option", { name: /^none$/i })).toBeInTheDocument();
  });

  it("truncates a long source label in the option text", async () => {
    const user = userEvent.setup();
    const longLabel = "A".repeat(60);
    render(
      <FacilitySourceIndexPicker
        id="picker-6"
        label="Source"
        sources={[makeSource({ label: longLabel })]}
        value={undefined}
        onChange={vi.fn()}
      />
    );

    await user.click(screen.getByRole("combobox", { name: /source/i }));

    const option = await screen.findByRole("option", { name: /^1\. Press/i });
    expect(option.textContent?.length ?? 0).toBeLessThan(longLabel.length);
  });
});
