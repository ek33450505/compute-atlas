import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Input } from "./input";

describe("Input", () => {
  it("renders a textbox with data-slot=input", () => {
    render(<Input aria-label="Name" />);
    const el = screen.getByRole("textbox", { name: "Name" });
    expect(el).toHaveAttribute("data-slot", "input");
  });

  it("passes through the type prop", () => {
    render(<Input type="email" aria-label="Email" />);
    const el = screen.getByRole("textbox", { name: "Email" });
    expect(el).toHaveAttribute("type", "email");
  });

  it("renders a placeholder", () => {
    render(<Input placeholder="Search facilities" />);
    expect(screen.getByPlaceholderText("Search facilities")).toBeInTheDocument();
  });

  it("is disabled when the disabled prop is set", () => {
    render(<Input aria-label="Disabled field" disabled />);
    expect(screen.getByRole("textbox", { name: "Disabled field" })).toBeDisabled();
  });

  it("supports controlled value + onChange via typing", async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();

    function Controlled() {
      const [value, setValue] = useState("");
      return (
        <Input
          aria-label="Controlled"
          value={value}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            setValue(e.target.value);
            handleChange(e);
          }}
        />
      );
    }

    render(<Controlled />);
    const el = screen.getByRole("textbox", { name: "Controlled" });
    await user.type(el, "hi");

    expect(handleChange).toHaveBeenCalledTimes(2);
    expect(el).toHaveValue("hi");
  });

  it("applies aria-invalid styling classes when aria-invalid is set", () => {
    render(<Input aria-label="Invalid" aria-invalid="true" />);
    const el = screen.getByRole("textbox", { name: "Invalid" });
    expect(el).toHaveAttribute("aria-invalid", "true");
    expect(el).toHaveClass(
      "aria-invalid:border-destructive",
      "aria-invalid:ring-3",
      "aria-invalid:ring-destructive/20"
    );
  });

  it("merges a passed className", () => {
    render(<Input aria-label="Custom" className="my-custom-class" />);
    expect(screen.getByRole("textbox", { name: "Custom" })).toHaveClass(
      "my-custom-class"
    );
  });
});
