import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { CiteThisFacility } from "./cite-this-facility";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const NAME = "Stargate Abilene";
const URL = "https://www.compute-atlas.com/facilities/stargate-abilene-tx";

describe("CiteThisFacility", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders a labelled heading", () => {
    render(<CiteThisFacility name={NAME} url={URL} />);
    expect(screen.getByRole("heading", { level: 2, name: "Cite this facility" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Cite this facility" })).toBeInTheDocument();
  });

  it("renders the citation with the quoted name, URL, local date and licence", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 6, 21, 30));
    render(<CiteThisFacility name={NAME} url={URL} />);
    const text = screen.getByText(/accessed/).textContent ?? "";
    expect(text).toContain(`“${NAME}”, Compute Atlas, ${URL}, accessed 2026-11-06. Licensed under`);
    expect(text).toContain("CC BY 4.0");
    expect(screen.getByRole("link", { name: /CC BY 4\.0/ })).toHaveAttribute(
      "href",
      "https://creativecommons.org/licenses/by/4.0/",
    );
  });

  it("points the how-to-cite link at the /data cite section", () => {
    render(<CiteThisFacility name={NAME} url={URL} />);
    expect(screen.getByRole("link", { name: "How to cite" })).toHaveAttribute(
      "href",
      "/data#cite-heading",
    );
    expect(screen.getByText(/Each record lists its own public sources/)).toBeInTheDocument();
  });

  it("copies the exact plain citation string with the current date", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 10, 6, 12, 0));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<CiteThisFacility name={NAME} url={URL} />);
    await user.click(screen.getByRole("button", { name: "Copy citation" }));
    expect(writeText).toHaveBeenCalledWith(
      `“${NAME}”, Compute Atlas, ${URL}, accessed 2026-11-06. Licensed under CC BY 4.0.`,
    );
  });

  it("copies exactly the string that is displayed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 10, 6, 12, 0));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<CiteThisFacility name={NAME} url={URL} />);
    const shown = screen.getByText(/accessed/).textContent;
    await user.click(screen.getByRole("button", { name: "Copy citation" }));
    expect(writeText).toHaveBeenCalledWith(shown);
  });

  it("re-stamps the displayed and copied date on focus and visibilitychange", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 10, 6, 23, 50));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<CiteThisFacility name={NAME} url={URL} />);
    expect(screen.getByText(/accessed/).textContent).toContain("accessed 2026-11-06.");

    vi.setSystemTime(new Date(2026, 10, 7, 8, 0));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByText(/accessed/).textContent).toContain("accessed 2026-11-07.");

    vi.setSystemTime(new Date(2026, 10, 8, 8, 0));
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const shown = screen.getByText(/accessed/).textContent;
    expect(shown).toContain("accessed 2026-11-08.");
    await user.click(screen.getByRole("button", { name: "Copy citation" }));
    expect(writeText).toHaveBeenCalledWith(shown);
  });

  it("shows the error toast when the clipboard write rejects", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 10, 6, 12, 0));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(new Error("denied"));
    render(<CiteThisFacility name={NAME} url={URL} />);
    await user.click(screen.getByRole("button", { name: "Copy citation" }));
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the citation");
  });
});
