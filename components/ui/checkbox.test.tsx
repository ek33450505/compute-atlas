import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Checkbox } from "./checkbox";

describe("Checkbox", () => {
  it("renders a checkbox role with data-slot", () => {
    render(<Checkbox aria-label="Accept" />);
    const checkbox = screen.getByRole("checkbox", { name: "Accept" });
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).toHaveAttribute("data-slot", "checkbox");
  });

  it("is unchecked by default", () => {
    render(<Checkbox aria-label="Accept" />);
    const checkbox = screen.getByRole("checkbox", { name: "Accept" });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toHaveAttribute("aria-checked", "false");
  });

  it("renders checked when defaultChecked is set", () => {
    render(<Checkbox aria-label="Accept" defaultChecked />);
    const checkbox = screen.getByRole("checkbox", { name: "Accept" });
    expect(checkbox).toBeChecked();
    expect(checkbox).toHaveAttribute("aria-checked", "true");
  });

  it("toggles checked state on click (uncontrolled)", async () => {
    const user = userEvent.setup();
    render(<Checkbox aria-label="Accept" />);
    const checkbox = screen.getByRole("checkbox", { name: "Accept" });

    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(checkbox).toHaveAttribute("aria-checked", "true");

    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toHaveAttribute("aria-checked", "false");
  });

  it("supports controlled checked + fires onCheckedChange", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();

    function Controlled() {
      const [checked, setChecked] = useState(false);
      return (
        <Checkbox
          aria-label="Accept"
          checked={checked}
          onCheckedChange={(next: boolean) => {
            onCheckedChange(next);
            setChecked(next);
          }}
        />
      );
    }

    render(<Controlled />);
    const checkbox = screen.getByRole("checkbox", { name: "Accept" });

    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);

    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(checkbox).toBeChecked();
  });

  it("is disabled when the disabled prop is set", () => {
    // Base UI's Checkbox.Root renders a <span role="checkbox">, not a native
    // <input>, so jest-dom's toBeDisabled() (which only inspects the DOM
    // `disabled` property on form-associated elements) never reports true
    // here even though the control is genuinely disabled. Assert the
    // aria-disabled wiring our wrapper passes through instead.
    render(<Checkbox aria-label="Accept" disabled />);
    const checkbox = screen.getByRole("checkbox", { name: "Accept" });
    expect(checkbox).toHaveAttribute("aria-disabled", "true");
    expect(checkbox).toHaveAttribute("data-disabled");
  });

  it("merges a passed className", () => {
    render(<Checkbox aria-label="Accept" className="my-extra-class" />);
    const checkbox = screen.getByRole("checkbox", { name: "Accept" });
    expect(checkbox).toHaveClass("my-extra-class");
    expect(checkbox).toHaveClass("peer");
  });
});
