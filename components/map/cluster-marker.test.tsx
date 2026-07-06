import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ClusterMarker } from "./cluster-marker";

describe("ClusterMarker", () => {
  it("renders the cluster count as visible text", () => {
    render(
      <ClusterMarker count={7} label="Cluster of 7 datacenters — activate to zoom in" onSelect={() => {}} />
    );
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("is discoverable by role=button with the provided aria-label", () => {
    const label = "Cluster of 12 datacenters — activate to zoom in";
    render(<ClusterMarker count={12} label={label} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  });

  it("calls onSelect when clicked", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <ClusterMarker count={3} label="Cluster of 3" onSelect={onSelect} />
    );
    await user.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("renders as a <button> element (type=button)", () => {
    render(
      <ClusterMarker count={5} label="Cluster of 5" onSelect={() => {}} />
    );
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });

  it("renders a larger element for count >= 100", () => {
    const { container: small } = render(
      <ClusterMarker count={9} label="small" onSelect={() => {}} />
    );
    const { container: large } = render(
      <ClusterMarker count={100} label="large" onSelect={() => {}} />
    );
    // The 100+ variant gets w-9/h-9 (36px), single-digit gets w-7/h-7 (28px).
    const smallBtn = small.querySelector("button")!;
    const largeBtn = large.querySelector("button")!;
    expect(largeBtn.className).toContain("w-9");
    expect(smallBtn.className).toContain("w-7");
  });
});
