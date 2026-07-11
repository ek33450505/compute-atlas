import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BasemapToggle } from "@/components/map/basemap-toggle";

describe("BasemapToggle", () => {
  it("renders a button with the accessible name 'Toggle satellite imagery'", () => {
    render(<BasemapToggle isSatellite={false} onToggle={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Toggle satellite imagery" })
    ).toBeInTheDocument();
  });

  it("aria-pressed is 'false' when isSatellite is false", () => {
    render(<BasemapToggle isSatellite={false} onToggle={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Toggle satellite imagery" })
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("aria-pressed is 'true' when isSatellite is true", () => {
    render(<BasemapToggle isSatellite={true} onToggle={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Toggle satellite imagery" })
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onToggle when clicked", async () => {
    const onToggle = vi.fn();
    render(<BasemapToggle isSatellite={false} onToggle={onToggle} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Toggle satellite imagery" })
    );
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
