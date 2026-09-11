import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { ShareButton } from "./share-button";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const PROPS = {
  title: "Example Facility",
  url: "https://www.compute-atlas.com/facilities/example-facility",
};

// Click via fireEvent, not @testing-library/user-event: user-event's
// setup() installs its own navigator.clipboard stub (documented in
// copy-button.test.tsx), which would fight with the navigator.share/
// navigator.clipboard stubs this file installs itself. fireEvent has no
// such side effect, so a plain beforeEach/afterEach pair is sufficient here.

let originalShare: unknown;
let originalClipboard: unknown;

beforeEach(() => {
  originalShare = (navigator as { share?: unknown }).share;
  originalClipboard = navigator.clipboard;
});

afterEach(() => {
  Object.defineProperty(navigator, "share", {
    value: originalShare,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(navigator, "clipboard", {
    value: originalClipboard,
    configurable: true,
    writable: true,
  });
  vi.restoreAllMocks();
});

function stubShare(impl: (data: ShareData) => Promise<void>) {
  Object.defineProperty(navigator, "share", {
    value: vi.fn(impl),
    configurable: true,
    writable: true,
  });
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(writeText) },
    configurable: true,
    writable: true,
  });
}

function removeShare() {
  Object.defineProperty(navigator, "share", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

function removeClipboard() {
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

describe("ShareButton", () => {
  it("renders with a distinct accessible name derived from the title", () => {
    removeShare();
    render(<ShareButton {...PROPS} />);
    expect(
      screen.getByRole("button", { name: "Share Example Facility" })
    ).toBeInTheDocument();
  });

  it("calls navigator.share with the right payload when available, and never touches the clipboard", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: share, configurable: true, writable: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    render(<ShareButton {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Share Example Facility" }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share).toHaveBeenCalledWith({ title: PROPS.title, url: PROPS.url });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("includes text in the share payload when provided", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { value: share, configurable: true, writable: true });

    render(<ShareButton {...PROPS} text="Check out this facility" />);
    fireEvent.click(screen.getByRole("button", { name: "Share Example Facility" }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share).toHaveBeenCalledWith({
      title: PROPS.title,
      text: "Check out this facility",
      url: PROPS.url,
    });
  });

  it("falls back to copying the link when navigator.share is absent, and announces success", async () => {
    removeShare();
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    render(<ShareButton {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Share Example Facility" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PROPS.url));
    expect(toast.success).toHaveBeenCalledWith("Link copied to clipboard");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows an error toast when navigator.share is absent and clipboard is unavailable too", async () => {
    removeShare();
    removeClipboard();

    render(<ShareButton {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Share Example Facility" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't copy the link"));
  });

  it("does NOT show an error toast when the user cancels the native share sheet (AbortError)", async () => {
    stubShare(() => Promise.reject(new DOMException("The user aborted a request.", "AbortError")));
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    render(<ShareButton {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Share Example Facility" }));

    // Let the rejected promise settle before asserting silence.
    await waitFor(() => expect(navigator.share).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to the clipboard when navigator.share rejects with a real error", async () => {
    stubShare(() => Promise.reject(new Error("share target unavailable")));
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    render(<ShareButton {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Share Example Facility" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PROPS.url));
    expect(toast.success).toHaveBeenCalledWith("Link copied to clipboard");
  });

  it("shows an error toast when the clipboard write itself rejects", async () => {
    removeShare();
    stubClipboard(() => Promise.reject(new Error("denied")));

    render(<ShareButton {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Share Example Facility" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't copy the link"));
  });
});
