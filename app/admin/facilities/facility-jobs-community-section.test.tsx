import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { Source } from "@/lib/schema";
import { FacilityJobsCommunitySection } from "./facility-jobs-community-section";

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    url: "https://example.com/article",
    label: "Press release",
    retrievedAt: "2026-01-01",
    kind: "press",
    ...overrides,
  };
}

describe("FacilityJobsCommunitySection", () => {
  it("renders jobs and community fields with their current values", () => {
    render(
      <FacilityJobsCommunitySection
        jobs={{ construction: 100, permanent: 25 }}
        community={{ status: "supported", notes: "Positive reception" }}
        sources={[]}
        onChangeJobs={vi.fn()}
        onChangeCommunity={vi.fn()}
      />
    );

    expect(screen.getByDisplayValue("100")).toBeInTheDocument();
    expect(screen.getByDisplayValue("25")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Positive reception")).toBeInTheDocument();
  });

  it("renders both fieldsets even when jobs/community are empty objects", () => {
    render(
      <FacilityJobsCommunitySection
        jobs={{}}
        community={{}}
        sources={[]}
        onChangeJobs={vi.fn()}
        onChangeCommunity={vi.fn()}
      />
    );

    expect(screen.getByText("Jobs")).toBeInTheDocument();
    expect(screen.getByText("Community")).toBeInTheDocument();
  });

  it("calls onChangeJobs with the FULL jobs object on a numeric edit (shallow-merge whole-object rule)", async () => {
    const user = userEvent.setup();
    const onChangeJobs = vi.fn();
    render(
      <FacilityJobsCommunitySection
        jobs={{ permanent: 25 }}
        community={{}}
        sources={[]}
        onChangeJobs={onChangeJobs}
        onChangeCommunity={vi.fn()}
      />
    );

    await user.type(screen.getByLabelText(/construction jobs/i), "5");

    const lastCall = onChangeJobs.mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ permanent: 25 });
    expect(lastCall.construction).not.toBeUndefined();
  });

  it("parses permanent as a nonnegative integer", async () => {
    const user = userEvent.setup();
    const onChangeJobs = vi.fn();
    render(
      <FacilityJobsCommunitySection
        jobs={{}}
        community={{}}
        sources={[]}
        onChangeJobs={onChangeJobs}
        onChangeCommunity={vi.fn()}
      />
    );

    // Single-character type: this component receives `jobs` as a static
    // prop from the test, not from live parent state (a `vi.fn()` mock
    // doesn't feed a new prop back in), so a multi-character `user.type`
    // call would re-render each keystroke against the SAME stale prop value
    // and only the last keystroke's effect would be observed — same
    // single-char convention already used elsewhere in this file/suite for
    // prop-mocked (as opposed to internally-stateful) numeric fields.
    await user.type(screen.getByLabelText(/permanent jobs/i), "7");

    const lastCall = onChangeJobs.mock.calls.at(-1)?.[0];
    expect(lastCall.permanent).toBe(7);
    expect(Number.isInteger(lastCall.permanent)).toBe(true);
  });

  it("selects a community status via the Select and reports it in onChangeCommunity", async () => {
    const user = userEvent.setup();
    const onChangeCommunity = vi.fn();
    render(
      <FacilityJobsCommunitySection
        jobs={{}}
        community={{}}
        sources={[]}
        onChangeJobs={vi.fn()}
        onChangeCommunity={onChangeCommunity}
      />
    );

    await user.click(screen.getByRole("combobox", { name: /^status/i }));
    const contestedOption = await screen.findByRole("option", { name: /^contested$/i });
    await user.click(contestedOption);

    expect(onChangeCommunity).toHaveBeenCalledWith(
      expect.objectContaining({ status: "contested" })
    );
  });

  it("wires the live sources array into both jobs.sourceIndex and community.sourceIndex pickers", async () => {
    const user = userEvent.setup();
    const sources = [makeSource({ label: "Only source" })];
    render(
      <FacilityJobsCommunitySection
        jobs={{}}
        community={{}}
        sources={sources}
        onChangeJobs={vi.fn()}
        onChangeCommunity={vi.fn()}
      />
    );

    const pickers = screen.getAllByRole("combobox", { name: /^source \(optional\)/i });
    expect(pickers).toHaveLength(2);

    await user.click(pickers[0]);
    expect(await screen.findByRole("option", { name: /only source/i })).toBeInTheDocument();
  });

  it("sets jobs.sourceIndex without disturbing community state", async () => {
    const user = userEvent.setup();
    const onChangeJobs = vi.fn();
    const sources = [makeSource({ label: "Pick me" })];
    render(
      <FacilityJobsCommunitySection
        jobs={{ construction: 3 }}
        community={{ status: "mixed" }}
        sources={sources}
        onChangeJobs={onChangeJobs}
        onChangeCommunity={vi.fn()}
      />
    );

    const pickers = screen.getAllByRole("combobox", { name: /^source \(optional\)/i });
    await user.click(pickers[0]);
    const option = await screen.findByRole("option", { name: /pick me/i });
    await user.click(option);

    expect(onChangeJobs).toHaveBeenCalledWith({ construction: 3, sourceIndex: 0 });
  });
});
