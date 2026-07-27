import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { ShareLinkButton } from "./share-link-button";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// user-event installs its own navigator.clipboard stub as part of
// userEvent.setup() (visible at runtime as a `Clipboard` instance carrying
// internal `resetClipboardStub`/`detachClipboardStub` hooks). That install
// happens AFTER this file's module scope runs, so the mock must be applied
// post-setup by spying on the already-installed stub rather than replacing
// `navigator.clipboard` up front in a `beforeEach`.

describe("ShareLinkButton", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders an accessible Copy link button", () => {
    render(<ShareLinkButton />);
    expect(
      screen.getByRole("button", { name: /copy .*link/i })
    ).toBeInTheDocument();
  });

  it("copies the current URL and shows a success toast", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    render(<ShareLinkButton />);
    await user.click(screen.getByRole("button", { name: /copy .*link/i }));
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(toast.success).toHaveBeenCalledWith("Link copied to clipboard");
  });

  it("shows an error toast when the clipboard write rejects", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(
      new Error("denied")
    );
    render(<ShareLinkButton />);
    await user.click(screen.getByRole("button", { name: /copy .*link/i }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the link");
  });

  it("falls back to an error toast when navigator.clipboard is unavailable", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    render(<ShareLinkButton />);
    await user.click(screen.getByRole("button", { name: /copy .*link/i }));
    expect(writeText).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the link");
  });
});
