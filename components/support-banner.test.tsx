import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname } from "next/navigation";
import {
  DISMISSED_KEY,
  SupportBanner,
  VISITS_KEY,
  isBannerExcludedRoute,
  shouldShowOnVisits,
} from "./support-banner";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn().mockReturnValue("/"),
}));

const REGION = { name: "Support Compute Atlas" };
const DISMISS = { name: "Dismiss support message" };

// Node 26 ships a global `localStorage` that can shadow jsdom's (undefined
// without --localstorage-file), so install a deterministic in-memory Storage.
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

function install(name: "localStorage" | "sessionStorage") {
  Object.defineProperty(window, name, {
    value: new MemoryStorage(),
    configurable: true,
  });
}

function scrollTo(y: number) {
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
  act(() => {
    window.dispatchEvent(new Event("scroll"));
  });
}

const barH = () => document.documentElement.style.getPropertyValue("--support-bar-h");

beforeEach(() => {
  install("localStorage");
  install("sessionStorage");
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  vi.mocked(usePathname).mockReturnValue("/facilities/x");
});

afterEach(() => {
  document.getElementById("main-content")?.remove();
  vi.restoreAllMocks();
});

describe("pure helpers", () => {
  it("shouldShowOnVisits needs two visits", () => {
    expect(shouldShowOnVisits(1)).toBe(false);
    expect(shouldShowOnVisits(2)).toBe(true);
  });
});

describe("isBannerExcludedRoute", () => {
  it.each(["/admin", "/admin/x", "/map", "/embed/states/texas", "/support"])(
    "excludes %s",
    (path) => {
      expect(isBannerExcludedRoute(path)).toBe(true);
    },
  );

  it.each(["/", "/facilities/x", "/about", "/administrators"])(
    "allows %s",
    (path) => {
      expect(isBannerExcludedRoute(path)).toBe(false);
    },
  );
});

describe("SupportBanner", () => {
  it("renders nothing on a first visit with no scroll", () => {
    render(<SupportBanner />);
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
  });

  it("renders the card content on the second visit", () => {
    window.localStorage.setItem(VISITS_KEY, "1");
    render(<SupportBanner />);
    expect(screen.getByRole("region", REGION)).toBeInTheDocument();
    expect(screen.getByText("Support the atlas")).toBeInTheDocument();
    expect(
      screen.getByText("Independent, open source, no ads. Compute Atlas is reader-supported."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("renders after scrolling a viewport on a first visit", () => {
    render(<SupportBanner />);
    scrollTo(799);
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
    scrollTo(800);
    expect(screen.getByRole("region", REGION)).toBeInTheDocument();
  });

  it("counts a visit once per session across mounts", () => {
    render(<SupportBanner />).unmount();
    expect(window.localStorage.getItem(VISITS_KEY)).toBe("1");
    render(<SupportBanner />);
    expect(window.localStorage.getItem(VISITS_KEY)).toBe("1");
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
  });

  it.each(["-100", "1.5", "abc"])("treats a stored visit count of %s as 0", (raw) => {
    window.localStorage.setItem(VISITS_KEY, raw);
    render(<SupportBanner />);
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
    expect(window.localStorage.getItem(VISITS_KEY)).toBe("1");
  });

  describe("session dismissal", () => {
    it("hides on dismiss and stays hidden on a re-mount in the same session", async () => {
      window.localStorage.setItem(VISITS_KEY, "3");
      const first = render(<SupportBanner />);
      await userEvent.click(screen.getByRole("button", DISMISS));
      expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
      expect(window.sessionStorage.getItem(DISMISSED_KEY)).toBe("1");
      expect(window.localStorage.getItem(DISMISSED_KEY)).toBeNull();
      first.unmount();
      render(<SupportBanner />);
      expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
    });

    it("comes back in a new session", async () => {
      window.localStorage.setItem(VISITS_KEY, "3");
      const first = render(<SupportBanner />);
      await userEvent.click(screen.getByRole("button", DISMISS));
      first.unmount();

      install("sessionStorage"); // new browser session; localStorage persists
      render(<SupportBanner />);
      expect(screen.getByRole("region", REGION)).toBeInTheDocument();
    });

    it("removes a legacy localStorage dismissal on mount and shows", () => {
      window.localStorage.setItem(VISITS_KEY, "3");
      window.localStorage.setItem(DISMISSED_KEY, String(Date.now()));
      render(<SupportBanner />);
      expect(window.localStorage.getItem(DISMISSED_KEY)).toBeNull();
      expect(screen.getByRole("region", REGION)).toBeInTheDocument();
    });

    it("clicking the Ko-fi link dismisses for the session", async () => {
      window.localStorage.setItem(VISITS_KEY, "3");
      render(<SupportBanner />);
      await userEvent.click(
        screen.getByRole("link", { name: /^Support on Ko-fi/i }),
      );
      expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
      expect(window.sessionStorage.getItem(DISMISSED_KEY)).toBe("1");
    });

    it("clicking Why support dismisses for the session", async () => {
      window.localStorage.setItem(VISITS_KEY, "3");
      render(<SupportBanner />);
      await userEvent.click(screen.getByRole("link", { name: "Why support?" }));
      expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
      expect(window.sessionStorage.getItem(DISMISSED_KEY)).toBe("1");
    });
  });

  it("has a Why support link to /support and no link named Support the atlas", () => {
    window.localStorage.setItem(VISITS_KEY, "3");
    render(<SupportBanner />);
    expect(screen.getByRole("link", { name: "Why support?" })).toHaveAttribute(
      "href",
      "/support",
    );
    expect(screen.queryByRole("link", { name: /^Support the atlas$/ })).not.toBeInTheDocument();
  });

  it("does not crash when storage throws; scroll path and in-memory dismissal work", async () => {
    vi.spyOn(MemoryStorage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(MemoryStorage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(MemoryStorage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<SupportBanner />);
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
    scrollTo(900);
    expect(screen.getByRole("region", REGION)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", DISMISS));
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
  });

  it("survives setItem throwing (quota): shows, dismisses in-session", async () => {
    window.localStorage.setItem(VISITS_KEY, "1");
    vi.spyOn(MemoryStorage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    render(<SupportBanner />);
    expect(screen.getByRole("region", REGION)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", DISMISS));
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
  });

  it.each(["/admin", "/admin/x", "/map", "/embed/states/texas", "/support"])(
    "renders nothing on %s",
    (path) => {
      vi.mocked(usePathname).mockReturnValue(path);
      window.localStorage.setItem(VISITS_KEY, "3");
      render(<SupportBanner />);
      expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
    },
  );

  it("follows route changes: excluded to eligible, and back (clearing the CSS var)", () => {
    window.localStorage.setItem(VISITS_KEY, "3");
    vi.mocked(usePathname).mockReturnValue("/map");
    const view = render(<SupportBanner />);
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();

    vi.mocked(usePathname).mockReturnValue("/about");
    view.rerender(<SupportBanner />);
    expect(screen.getByRole("region", REGION)).toBeInTheDocument();
    expect(barH()).not.toBe("");

    vi.mocked(usePathname).mockReturnValue("/admin/x");
    view.rerender(<SupportBanner />);
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
    expect(barH()).toBe("");
  });

  it("sets --support-bar-h while visible and clears it on dismiss and unmount", async () => {
    window.localStorage.setItem(VISITS_KEY, "3");
    const a = render(<SupportBanner />);
    expect(barH()).toMatch(/^\d+px$/);
    await userEvent.click(screen.getByRole("button", DISMISS));
    expect(barH()).toBe("");
    a.unmount();

    install("sessionStorage");
    const b = render(<SupportBanner />);
    expect(barH()).not.toBe("");
    b.unmount();
    expect(barH()).toBe("");
  });

  it("moves focus to #main-content when the focused banner control hides", async () => {
    document.body.insertAdjacentHTML("beforeend", '<main id="main-content"></main>');
    window.localStorage.setItem(VISITS_KEY, "3");
    const user = userEvent.setup();
    render(<SupportBanner />);
    await user.tab(); // dismiss button is first in DOM order
    expect(screen.getByRole("button", DISMISS)).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(document.getElementById("main-content")).toHaveFocus();
  });

  it("removes the scroll listener on unmount", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    render(<SupportBanner />).unmount();
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
  });

  describe("bar height tracking", () => {
    let height = 56;
    let roCallback: (() => void) | undefined;
    const disconnect = vi.fn();

    beforeEach(() => {
      height = 56;
      roCallback = undefined;
      disconnect.mockClear();
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(cb: () => void) {
            roCallback = cb;
          }
          observe() {}
          unobserve() {}
          disconnect = disconnect;
        },
      );
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
        () => height,
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("publishes height plus the bottom offset, follows resizes, disconnects on unmount", () => {
      vi.spyOn(window, "getComputedStyle").mockReturnValue({
        bottom: "16px",
      } as CSSStyleDeclaration);
      window.localStorage.setItem(VISITS_KEY, "3");
      const view = render(<SupportBanner />);
      expect(barH()).toBe("72px");
      height = 80;
      act(() => roCallback?.());
      expect(barH()).toBe("96px");
      view.unmount();
      expect(disconnect).toHaveBeenCalled();
      expect(barH()).toBe("");
    });

    it("uses the bare height when there is no bottom offset", () => {
      window.localStorage.setItem(VISITS_KEY, "3");
      render(<SupportBanner />);
      expect(barH()).toBe("56px");
    });

    it("disconnects the observer on dismiss", async () => {
      window.localStorage.setItem(VISITS_KEY, "3");
      render(<SupportBanner />);
      await userEvent.click(screen.getByRole("button", DISMISS));
      expect(disconnect).toHaveBeenCalled();
      expect(barH()).toBe("");
    });
  });
});
