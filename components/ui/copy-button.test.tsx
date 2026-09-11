import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { Share2 } from "lucide-react";
import { CopyButton } from "./copy-button";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// user-event installs its own navigator.clipboard stub as part of
// userEvent.setup() (visible at runtime as a `Clipboard` instance carrying
// internal `resetClipboardStub`/`detachClipboardStub` hooks). That install
// happens AFTER this file's module scope runs, so the mock must be applied
// post-setup by spying on the already-installed stub rather than replacing
// `navigator.clipboard` up front in a `beforeEach` (same pattern as
// share-link-button.test.tsx).

const PROPS = {
  getText: () => "copy me",
  label: "Copy thing",
  ariaLabel: "Copy the thing",
  successMessage: "Thing copied",
  errorMessage: "Couldn't copy the thing",
  icon: Share2,
};

describe("CopyButton", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders with the given label as its accessible name", () => {
    render(<CopyButton {...PROPS} />);
    expect(screen.getByRole("button", { name: "Copy the thing" })).toBeInTheDocument();
  });

  it("copies the result of getText() and shows the success toast", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    render(<CopyButton {...PROPS} />);
    await user.click(screen.getByRole("button", { name: "Copy the thing" }));
    expect(writeText).toHaveBeenCalledWith("copy me");
    expect(toast.success).toHaveBeenCalledWith("Thing copied");
  });

  it("shows the error toast when the clipboard write rejects", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("denied"));
    render(<CopyButton {...PROPS} />);
    await user.click(screen.getByRole("button", { name: "Copy the thing" }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the thing");
  });

  it("falls back to the error toast when navigator.clipboard is unavailable", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    render(<CopyButton {...PROPS} />);
    await user.click(screen.getByRole("button", { name: "Copy the thing" }));
    expect(writeText).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the thing");
  });

  it("calls getText() at click time, not at render time", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    let value = "first";
    render(<CopyButton {...PROPS} getText={() => value} />);
    value = "second";
    await user.click(screen.getByRole("button", { name: "Copy the thing" }));
    expect(writeText).toHaveBeenCalledWith("second");
  });
});
