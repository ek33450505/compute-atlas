import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ActivityList } from "./activity-list";
import { CommunityFilter } from "./community-filter";
import type { ActivityEntry } from "@/lib/data";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const base = { kind: "update" as const, label: "facility updated" };
const mixed: ActivityEntry[] = [
  { ...base, facilityId: "a", facilityName: "Facility A", timestamp: new Date("2026-07-12T00:00:00Z") },
  { ...base, facilityId: "b", facilityName: "Facility B", timestamp: new Date("2026-07-11T00:00:00Z"), community: true },
  { ...base, facilityId: "c", facilityName: "Facility C", timestamp: new Date("2026-07-10T00:00:00Z") },
];

function renderFilter(entries: ActivityEntry[]) {
  return render(
    <CommunityFilter total={entries.length} communityCount={entries.filter((e) => e.community).length}>
      <ActivityList entries={entries} />
    </CommunityFilter>
  );
}

// jsdom does not load the Tailwind rule, so these assert the contract the CSS
// keys on (container attribute + per-item attribute), not computed visibility.
describe("CommunityFilter", () => {
  it("marks each list item with whether it is a community entry", () => {
    renderFilter(mixed);
    const flags = screen.getAllByRole("listitem").map((li) => li.getAttribute("data-community"));
    expect(flags).toEqual(["false", "true", "false"]);
  });

  it("starts unpressed with the container filter off and the full count", () => {
    const { container } = renderFilter(mixed);
    expect(screen.getByRole("button", { name: "Community submissions only" })).toHaveAttribute("aria-pressed", "false");
    expect(container.firstElementChild).toHaveAttribute("data-community-only", "false");
    expect(screen.getByText("Showing 3 of 3 updates")).toBeInTheDocument();
  });

  it("sets the container attribute, flips aria-pressed and shows the community count when pressed", async () => {
    const user = userEvent.setup();
    const { container } = renderFilter(mixed);
    const toggle = screen.getByRole("button", { name: "Community submissions only" });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(container.firstElementChild).toHaveAttribute("data-community-only", "true");
    expect(screen.getByText("Showing 1 of 3 updates")).toBeInTheDocument();
  });

  it("emits the container-keyed hide-rule class", () => {
    const { container } = renderFilter(mixed);
    const cls = container.firstElementChild!.getAttribute("class") ?? "";
    expect(cls).toContain("data-[community-only=true]:");
    expect(cls).toContain("li[data-community=false]]:hidden");
    expect(cls).not.toContain("li[data-community=true]]:hidden");
  });

  it("emits the filtered-mode divider override classes", () => {
    const { container } = renderFilter(mixed);
    const cls = container.firstElementChild!.getAttribute("class") ?? "";
    expect(cls).toContain("data-[community-only=true]:[&_li]:border-b-0");
    expect(cls).toContain(
      "data-[community-only=true]:[&_li[data-community=true]~li[data-community=true]]:border-t"
    );
  });

  it("uses the singular when there is exactly one update", () => {
    renderFilter([mixed[1]]);
    expect(screen.getByText("Showing 1 of 1 update")).toBeInTheDocument();
  });

  it("returns to the full state when toggled twice", async () => {
    const user = userEvent.setup();
    const { container } = renderFilter(mixed);
    const toggle = screen.getByRole("button", { name: "Community submissions only" });
    await user.click(toggle);
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(container.firstElementChild).toHaveAttribute("data-community-only", "false");
    expect(screen.getByText("Showing 3 of 3 updates")).toBeInTheDocument();
  });

  it("announces the count through a polite status region", () => {
    renderFilter(mixed);
    expect(screen.getByRole("status")).toHaveTextContent("Showing 3 of 3 updates");
  });

  it("renders no toggle when there are no community entries", () => {
    renderFilter(mixed.filter((e) => !e.community));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});
