import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ViewToggle3D } from "@/components/map/view-toggle-3d";

describe("ViewToggle3D", () => {
  it("renders a button with the accessible name 'Toggle 3D tilted view'", () => {
    render(<ViewToggle3D is3D={false} onToggle={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Toggle 3D tilted view" })
    ).toBeInTheDocument();
  });

  it("aria-pressed is 'false' when is3D is false", () => {
    render(<ViewToggle3D is3D={false} onToggle={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Toggle 3D tilted view" })
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("aria-pressed is 'true' when is3D is true", () => {
    render(<ViewToggle3D is3D={true} onToggle={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Toggle 3D tilted view" })
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("calls onToggle when clicked", async () => {
    const onToggle = vi.fn();
    render(<ViewToggle3D is3D={false} onToggle={onToggle} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Toggle 3D tilted view" })
    );
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
