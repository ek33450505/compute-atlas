import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrintBriefButton } from "./print-brief-button";

describe("PrintBriefButton", () => {
  it("renders an accessible print button", () => {
    render(<PrintBriefButton />);
    expect(
      screen.getByRole("button", { name: /print this brief/i })
    ).toBeInTheDocument();
  });

  it("calls window.print when clicked", async () => {
    const printSpy = vi.spyOn(window, "print").mockImplementation(() => {});
    const user = userEvent.setup();
    render(<PrintBriefButton />);
    await user.click(screen.getByRole("button", { name: /print this brief/i }));
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it("is hidden from the printout it produces", () => {
    render(<PrintBriefButton />);
    expect(
      screen.getByRole("button", { name: /print this brief/i })
    ).toHaveClass("print:hidden");
  });

  it("carries focus-visible styling", () => {
    render(<PrintBriefButton />);
    // Quiet-treatment control (QUIET_ACTION_CLASS, lib/utils.ts) — asserted
    // here directly so a future control doesn't regress to no focus ring
    // the way an earlier one did.
    expect(
      screen.getByRole("button", { name: /print this brief/i })
    ).toHaveClass(
      "focus-visible:outline-none",
      "focus-visible:ring-2",
      "focus-visible:ring-ring",
      "focus-visible:ring-offset-2"
    );
  });

  it("preserves a 44px touch target despite the quiet text-scale styling", () => {
    render(<PrintBriefButton />);
    expect(
      screen.getByRole("button", { name: /print this brief/i })
    ).toHaveClass("min-h-11");
  });
});
