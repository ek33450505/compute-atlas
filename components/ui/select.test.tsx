import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
//
// Item values match their labels 1:1 (e.g. value="Apple" -> "Apple") so
// assertions can read the trigger's displayed text directly — Base UI's
// <Select.Value> mirrors the raw stored value, not the matching item's
// rendered children, unless an `items` map / `itemToStringLabel` is supplied
// (which our wrapper doesn't add).

function Fixture({
  defaultValue,
  value,
  onValueChange,
  disabled,
  defaultOpen,
  size,
}: {
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string | null) => void;
  disabled?: boolean;
  defaultOpen?: boolean;
  size?: "sm" | "default";
}) {
  return (
    <Select
      defaultValue={defaultValue}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      defaultOpen={defaultOpen}
    >
      <SelectTrigger size={size}>
        <SelectValue placeholder="Select a fruit" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="Apple">Apple</SelectItem>
        <SelectItem value="Banana">Banana</SelectItem>
      </SelectContent>
    </Select>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Select", () => {
  it("renders the trigger showing the placeholder when no value is selected", () => {
    render(<Fixture />);
    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Select a fruit");
    expect(trigger).toHaveAttribute("data-placeholder");
  });

  it("renders the trigger showing the selected value (uncontrolled defaultValue)", () => {
    render(<Fixture defaultValue="Apple" />);
    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Apple");
    expect(trigger).not.toHaveAttribute("data-placeholder");
  });

  it("opens via defaultOpen to a listbox with option items", () => {
    render(<Fixture defaultOpen />);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Apple" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Banana" })).toBeInTheDocument();
  });

  it("opens on trigger click, selects an option, updates the trigger, and fires onValueChange (uncontrolled)", async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(<Fixture onValueChange={handleChange} />);

    await user.click(screen.getByRole("combobox"));
    const option = await screen.findByRole("option", { name: "Banana" });
    await user.click(option);

    expect(handleChange).toHaveBeenCalledWith("Banana", expect.anything());
    expect(screen.getByRole("combobox")).toHaveTextContent("Banana");
  });

  it("keeps the controlled value unchanged after selecting a different option until the parent updates it", async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(<Fixture value="Apple" onValueChange={handleChange} />);

    expect(screen.getByRole("combobox")).toHaveTextContent("Apple");

    await user.click(screen.getByRole("combobox"));
    const option = await screen.findByRole("option", { name: "Banana" });
    await user.click(option);

    expect(handleChange).toHaveBeenCalledWith("Banana", expect.anything());
    // Controlled: the parent never updated `value`, so the trigger still shows "Apple".
    expect(screen.getByRole("combobox")).toHaveTextContent("Apple");
  });

  it("renders a disabled trigger that cannot be opened", async () => {
    const user = userEvent.setup();
    render(<Fixture disabled />);

    const trigger = screen.getByRole("combobox");
    expect(trigger).toBeDisabled();

    await user.click(trigger);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("applies data-slot attributes to trigger, content, and items", () => {
    render(<Fixture defaultOpen />);
    expect(screen.getByRole("combobox")).toHaveAttribute(
      "data-slot",
      "select-trigger"
    );
    expect(
      document.querySelector('[data-slot="select-content"]')
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Apple" })).toHaveAttribute(
      "data-slot",
      "select-item"
    );
  });

  it("maps the size prop to a data-size attribute on the trigger", () => {
    const { rerender } = render(<Fixture size="sm" />);
    expect(screen.getByRole("combobox")).toHaveAttribute("data-size", "sm");

    rerender(<Fixture size="default" />);
    expect(screen.getByRole("combobox")).toHaveAttribute(
      "data-size",
      "default"
    );
  });

  it("merges a passed className onto the trigger", () => {
    render(
      <Select>
        <SelectTrigger className="my-custom-class">
          <SelectValue placeholder="Select a fruit" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="Apple">Apple</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(screen.getByRole("combobox")).toHaveClass("my-custom-class");
  });
});
