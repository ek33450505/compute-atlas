import { vi, describe, it, expect, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockAction } = vi.hoisted(() => ({ mockAction: vi.fn() }));
vi.mock("@/app/admin/refresh-site-action", () => ({ refreshSiteAction: mockAction }));

import { RefreshSiteButton } from "./refresh-site-button";

describe("RefreshSiteButton", () => {
  beforeEach(() => mockAction.mockReset());

  it("renders an enabled button and an empty polite status region", () => {
    render(<RefreshSiteButton />);

    expect(screen.getByRole("button", { name: "Refresh site" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("announces success", async () => {
    mockAction.mockResolvedValue({ ok: true });
    render(<RefreshSiteButton />);

    await userEvent.click(screen.getByRole("button", { name: "Refresh site" }));

    expect(await screen.findByText("Site refresh requested")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Site refresh requested");
  });

  it("announces failure", async () => {
    mockAction.mockResolvedValue({ ok: false, error: "Refresh failed" });
    render(<RefreshSiteButton />);

    await userEvent.click(screen.getByRole("button", { name: "Refresh site" }));

    expect(await screen.findByText("Refresh failed")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Refresh failed");
  });

  it("keeps focus, shows pending text and ignores a second activation while pending", async () => {
    let resolve!: (v: unknown) => void;
    mockAction.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<RefreshSiteButton />);
    const button = screen.getByRole("button", { name: "Refresh site" });

    await userEvent.click(button);

    expect(await screen.findByText("Refreshing…")).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveFocus();

    await userEvent.click(button);
    expect(mockAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve({ ok: true });
    });
    expect(await screen.findByText("Site refresh requested")).toBeInTheDocument();
    // useActionState queues a second submit and runs it after the first
    // settles, so the call count must be re-checked once pending clears.
    expect(mockAction).toHaveBeenCalledTimes(1);
  });

  it("runs the action once when activated twice before the pending re-render", async () => {
    let resolve!: (v: unknown) => void;
    mockAction.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<RefreshSiteButton />);
    const button = screen.getByRole("button", { name: "Refresh site" });

    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await act(async () => {
      resolve({ ok: true });
    });

    expect(await screen.findByText("Site refresh requested")).toBeInTheDocument();
    expect(mockAction).toHaveBeenCalledTimes(1);
  });

  it("accepts a later activation after the action settles immediately", async () => {
    mockAction.mockResolvedValue({ ok: true });
    render(<RefreshSiteButton />);
    const button = screen.getByRole("button", { name: "Refresh site" });

    await userEvent.click(button);
    await screen.findByText("Site refresh requested");
    await userEvent.click(button);

    await waitFor(() => expect(mockAction).toHaveBeenCalledTimes(2));
  });

  it("shows the failure state and stays usable when the action rejects", async () => {
    mockAction.mockRejectedValueOnce(new Error("boom"));
    mockAction.mockResolvedValueOnce({ ok: true });
    render(<RefreshSiteButton />);
    const button = screen.getByRole("button", { name: "Refresh site" });

    await userEvent.click(button);
    expect(await screen.findByText("Refresh failed")).toBeInTheDocument();

    await userEvent.click(button);
    expect(await screen.findByText("Site refresh requested")).toBeInTheDocument();
    expect(mockAction).toHaveBeenCalledTimes(2);
  });
});
