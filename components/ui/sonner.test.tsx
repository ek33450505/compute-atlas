import { describe, it, expect, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { Toaster } from "./sonner";

// sonner's list host (<ol data-sonner-toaster>) only mounts once at least one
// toast is active, so the class/position/icon contract tests below trigger a
// real toast via the `toast` API rather than asserting against the always-empty
// <section> shell. Each test dismisses its toast afterward since sonner's toast
// store is a module-level singleton shared across renders.
afterEach(() => {
  toast.dismiss();
});

describe("Toaster", () => {
  it("mounts a notifications region without crashing", () => {
    render(<Toaster />);
    expect(
      document.querySelector("section[aria-label*='Notifications']")
    ).toBeInTheDocument();
  });

  it("applies the toaster/group classes to the list host once a toast is active", async () => {
    render(<Toaster />);
    toast("hello");
    const list = await waitFor(() => {
      const el = document.querySelector("[data-sonner-toaster]");
      expect(el).toBeInTheDocument();
      return el as HTMLElement;
    });
    expect(list).toHaveClass("toaster", "group");
  });

  it("forwards additional props (position) through to sonner", async () => {
    render(<Toaster position="top-center" />);
    toast("hello");
    const list = await waitFor(() => {
      const el = document.querySelector("[data-sonner-toaster]");
      expect(el).toBeInTheDocument();
      return el as HTMLElement;
    });
    expect(list).toHaveAttribute("data-x-position", "center");
    expect(list).toHaveAttribute("data-y-position", "top");
  });

  it("gates the loading spinner animation behind motion-reduce", async () => {
    // jsdom can't evaluate the prefers-reduced-motion media query itself, so this
    // asserts the class contract instead: animate-spin must be paired with the
    // motion-reduce: variant that disables it (s59 Unit 2).
    render(<Toaster />);
    toast.loading("loading...");
    const spinner = await waitFor(() => {
      const el = document.querySelector(".sonner-loader svg");
      expect(el).toBeInTheDocument();
      return el as SVGElement;
    });
    expect(spinner).toHaveClass("animate-spin", "motion-reduce:animate-none");
  });
});
