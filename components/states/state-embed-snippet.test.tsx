import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { StateEmbedSnippet } from "./state-embed-snippet";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Same post-setup clipboard-spy pattern as share-link-button.test.tsx and
// copy-button.test.tsx — see those files' comments for why.

const SNIPPET =
  '<iframe src="https://www.compute-atlas.com/embed/states/texas" width="100%" height="480" style="border:0" loading="lazy" title="Data centers in Texas — Compute Atlas"></iframe>';

describe("StateEmbedSnippet", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the snippet inside a code block", () => {
    render(<StateEmbedSnippet snippet={SNIPPET} stateName="Texas" />);
    expect(screen.getByText(SNIPPET)).toBeInTheDocument();
  });

  it("renders a copy control with an accessible name naming the state", () => {
    render(<StateEmbedSnippet snippet={SNIPPET} stateName="Texas" />);
    expect(
      screen.getByRole("button", { name: "Copy the embeddable map snippet for Texas" })
    ).toBeInTheDocument();
  });

  it("copies the snippet and shows a success toast", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    render(<StateEmbedSnippet snippet={SNIPPET} stateName="Texas" />);
    await user.click(
      screen.getByRole("button", { name: "Copy the embeddable map snippet for Texas" })
    );
    expect(writeText).toHaveBeenCalledWith(SNIPPET);
    expect(toast.success).toHaveBeenCalledWith("Embed snippet copied to clipboard");
  });

  it("shows an error toast when the clipboard write rejects", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("denied"));
    render(<StateEmbedSnippet snippet={SNIPPET} stateName="Texas" />);
    await user.click(
      screen.getByRole("button", { name: "Copy the embeddable map snippet for Texas" })
    );
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the embed snippet");
  });
});
