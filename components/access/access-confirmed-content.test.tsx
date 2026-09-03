import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AccessConfirmedContent } from "./access-confirmed-content";

afterEach(() => {
  window.location.hash = "";
});

describe("AccessConfirmedContent", () => {
  it("shows the token from the URL fragment and a curl example using it", () => {
    window.location.hash = "#token=abc123DEF";
    render(<AccessConfirmedContent />);

    expect(screen.getByText("abc123DEF")).toBeInTheDocument();
    expect(screen.getByText(/Bearer abc123DEF/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy access token/i })).toBeInTheDocument();
  });

  it("shows a 'no token found' state when there is no fragment", () => {
    render(<AccessConfirmedContent />);

    expect(screen.getByRole("heading", { name: "No token found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Request access" })).toBeInTheDocument();
  });

  // userEvent.setup() installs its own navigator.clipboard stub, so the spy
  // must be applied AFTER setup rather than replacing navigator.clipboard up
  // front — mirrors components/explorer/share-link-button.test.tsx exactly.
  it("copies the token to the clipboard on click", async () => {
    window.location.hash = "#token=copyme123";
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

    render(<AccessConfirmedContent />);

    await user.click(screen.getByRole("button", { name: /copy access token/i }));
    expect(writeText).toHaveBeenCalledWith("copyme123");
  });
});
