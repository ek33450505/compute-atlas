import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockAction, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockAction: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

vi.mock("@/app/admin/submissions/actions", () => ({
  refreshAggregatesAction: mockAction,
}));

import { RefreshTotalsButton } from "./refresh-totals-button";

describe("RefreshTotalsButton", () => {
  beforeEach(() => {
    mockAction.mockReset();
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  it("is described by its help text", () => {
    render(<RefreshTotalsButton />);
    expect(
      screen.getByRole("button", { name: "Refresh site totals" })
    ).toHaveAccessibleDescription(/Run once after approving a batch/);
  });

  it("calls the action and shows the success toast", async () => {
    mockAction.mockResolvedValue({ ok: true });
    render(<RefreshTotalsButton />);

    await userEvent.click(screen.getByRole("button", { name: "Refresh site totals" }));

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith(
        "Site totals refreshed — the homepage updates on its second reload."
      )
    );
    expect(mockAction).toHaveBeenCalledTimes(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("shows the error toast when the action throws", async () => {
    mockAction.mockRejectedValue(new Error("Unauthorized"));
    render(<RefreshTotalsButton />);

    await userEvent.click(screen.getByRole("button", { name: "Refresh site totals" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it("is disabled while the action is pending", async () => {
    let resolve!: (v: { ok: true }) => void;
    mockAction.mockReturnValue(new Promise((r) => (resolve = r)));
    render(<RefreshTotalsButton />);

    await userEvent.click(screen.getByRole("button", { name: "Refresh site totals" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh site totals" })).toBeDisabled()
    );

    resolve({ ok: true });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh site totals" })).toBeEnabled()
    );
  });
});
