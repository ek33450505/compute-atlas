import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname } from "next/navigation";
import {
  DISMISSED_KEY,
  PAGEVIEWS_KEY,
  SupportBanner,
  isBannerExcludedRoute,
  shouldShowOnPageViews,
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

// jsdom applies no Tailwind CSS, so stand in for the computed style of the
// `sm:fixed` card (position + bottom offset) or its in-flow phone layout.
function mockCardStyle(position: "fixed" | "relative", bottom = "0px") {
  const real = window.getComputedStyle.bind(window);
  // Only the banner section is faked; Testing Library's own style reads (role
  // queries) still get the real computed style.
  vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    const style = real(el, pseudo);
    if (el.getAttribute("aria-label") !== "Support Compute Atlas") return style;
    return new Proxy(style, {
      get: (target, prop) =>
        prop === "position" ? position : prop === "bottom" ? bottom : Reflect.get(target, prop),
    });
  });
}

/** Mounts on "/" (page view 1), then navigates client-side to "/table" (view 2). */
function renderSecondPageView() {
  const view = render(<SupportBanner />);
  vi.mocked(usePathname).mockReturnValue("/table");
  view.rerender(<SupportBanner />);
  return view;
}

const barH = () => document.documentElement.style.getPropertyValue("--support-bar-h");

beforeEach(() => {
  install("localStorage");
  install("sessionStorage");
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
  vi.mocked(usePathname).mockReturnValue("/");
});

afterEach(() => {
  document.getElementById("main-content")?.remove();
  vi.restoreAllMocks();
});

describe("pure helpers", () => {
  it("shouldShowOnPageViews needs two page views", () => {
    expect(shouldShowOnPageViews(0)).toBe(false);
    expect(shouldShowOnPageViews(1)).toBe(false);
    expect(shouldShowOnPageViews(2)).toBe(true);
  });
});

describe("isBannerExcludedRoute", () => {
  it.each([
    "/admin",
    "/admin/x",
    "/map",
    "/embed/states/texas",
    "/support",
    "/about",
    "/contribute",
    "/facilities/x",
  ])("excludes %s", (path) => {
    expect(isBannerExcludedRoute(path)).toBe(true);
  });

  it.each(["/", "/table", "/facilities", "/administrators", "/contributors"])(
    "allows %s",
    (path) => {
      expect(isBannerExcludedRoute(path)).toBe(false);
    },
  );
});

describe("SupportBanner", () => {
  it("renders nothing on the first page view, even after scrolling", () => {
    render(<SupportBanner />);
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
    scrollTo(5000);
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
  });

  it("renders the card content from the second page view", () => {
    renderSecondPageView();
    expect(screen.getByRole("region", REGION)).toBeInTheDocument();
    expect(screen.getByText("Support the atlas")).toBeInTheDocument();
    expect(
      screen.getByText("Independent, open source, no ads. Compute Atlas is reader-supported."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("counts a page view per pathname change, not per re-render", () => {
    const view = render(<SupportBanner />);
    view.rerender(<SupportBanner />);
    expect(window.sessionStorage.getItem(PAGEVIEWS_KEY)).toBe("1");
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
  });

  it("counts once under StrictMode's double-invoked effects", () => {
    render(
      <StrictMode>
        <SupportBanner />
      </StrictMode>,
    );
    expect(window.sessionStorage.getItem(PAGEVIEWS_KEY)).toBe("1");
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
  });

  it("keeps the count across mounts in the same session (full page loads)", () => {
    render(<SupportBanner />).unmount();
    render(<SupportBanner />);
    expect(window.sessionStorage.getItem(PAGEVIEWS_KEY)).toBe("2");
    expect(screen.getByRole("region", REGION)).toBeInTheDocument();
  });

  it("starts over in a new session", () => {
    render(<SupportBanner />).unmount();
    install("sessionStorage");
    render(<SupportBanner />);
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
  });

  it.each(["-100", "1.5", "abc"])("treats a stored page-view count of %s as 0", (raw) => {
    window.sessionStorage.setItem(PAGEVIEWS_KEY, raw);
    render(<SupportBanner />);
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(PAGEVIEWS_KEY)).toBe("1");
  });

  describe("session dismissal", () => {
    it("hides on dismiss and stays hidden across later page views", async () => {
      const view = renderSecondPageView();
      await userEvent.click(screen.getByRole("button", DISMISS));
      expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
      expect(window.sessionStorage.getItem(DISMISSED_KEY)).toBe("1");
      expect(window.localStorage.getItem(DISMISSED_KEY)).toBeNull();
      vi.mocked(usePathname).mockReturnValue("/stats");
      view.rerender(<SupportBanner />);
      expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
      view.unmount();
      render(<SupportBanner />);
      expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
    });

    it("comes back in a new session after two page views", async () => {
      const first = renderSecondPageView();
      await userEvent.click(screen.getByRole("button", DISMISS));
      first.unmount();

      install("sessionStorage"); // new browser session
      vi.mocked(usePathname).mockReturnValue("/");
      renderSecondPageView();
      expect(screen.getByRole("region", REGION)).toBeInTheDocument();
    });

    it("removes the retired localStorage keys on mount", () => {
      window.localStorage.setItem(DISMISSED_KEY, String(Date.now()));
      window.localStorage.setItem("ca-support-banner:visits", "5");
      window.sessionStorage.setItem("ca-support-banner:counted", "1");
      render(<SupportBanner />);
      expect(window.localStorage.getItem(DISMISSED_KEY)).toBeNull();
      expect(window.localStorage.getItem("ca-support-banner:visits")).toBeNull();
      expect(window.sessionStorage.getItem("ca-support-banner:counted")).toBeNull();
    });

    it("clicking the PayPal link dismisses for the session", async () => {
      renderSecondPageView();
      await userEvent.click(
        screen.getByRole("link", { name: /^Support on PayPal/i }),
      );
      expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
      expect(window.sessionStorage.getItem(DISMISSED_KEY)).toBe("1");
    });

    it("clicking Why support dismisses for the session", async () => {
      renderSecondPageView();
      await userEvent.click(screen.getByRole("link", { name: "Why support?" }));
      expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
      expect(window.sessionStorage.getItem(DISMISSED_KEY)).toBe("1");
    });
  });

  it("has a Why support link to /support and no link named Support the atlas", () => {
    renderSecondPageView();
    expect(screen.getByRole("link", { name: "Why support?" })).toHaveAttribute(
      "href",
      "/support",
    );
    expect(screen.queryByRole("link", { name: /^Support the atlas$/ })).not.toBeInTheDocument();
  });

  it("stays hidden, without crashing, when sessionStorage throws", () => {
    vi.spyOn(MemoryStorage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(MemoryStorage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(MemoryStorage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    renderSecondPageView();
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
  });

  it("survives setItem throwing on dismissal: hides in-session", async () => {
    renderSecondPageView();
    vi.spyOn(MemoryStorage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    await userEvent.click(screen.getByRole("button", DISMISS));
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
  });

  it.each([
    "/admin",
    "/admin/x",
    "/map",
    "/embed/states/texas",
    "/support",
    "/about",
    "/contribute",
    "/facilities/x",
  ])("renders nothing on %s even after many page views", (path) => {
    window.sessionStorage.setItem(PAGEVIEWS_KEY, "5");
    vi.mocked(usePathname).mockReturnValue(path);
    render(<SupportBanner />);
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
  });

  it("follows route changes: excluded to eligible, and back (clearing the CSS var)", () => {
    mockCardStyle("fixed", "16px");
    window.sessionStorage.setItem(PAGEVIEWS_KEY, "3");
    vi.mocked(usePathname).mockReturnValue("/map");
    const view = render(<SupportBanner />);
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();

    vi.mocked(usePathname).mockReturnValue("/table");
    view.rerender(<SupportBanner />);
    expect(screen.getByRole("region", REGION)).toBeInTheDocument();
    expect(barH()).not.toBe("");

    vi.mocked(usePathname).mockReturnValue("/facilities/x");
    view.rerender(<SupportBanner />);
    expect(screen.queryByRole("region", REGION)).not.toBeInTheDocument();
    expect(barH()).toBe("");
  });

  it("sets --support-bar-h while visible and clears it on dismiss and unmount", async () => {
    mockCardStyle("fixed");
    const a = renderSecondPageView();
    expect(barH()).toMatch(/^\d+px$/);
    await userEvent.click(screen.getByRole("button", DISMISS));
    expect(barH()).toBe("");
    a.unmount();

    install("sessionStorage");
    vi.mocked(usePathname).mockReturnValue("/");
    const b = renderSecondPageView();
    expect(barH()).not.toBe("");
    b.unmount();
    expect(barH()).toBe("");
  });

  it("does not reserve space while the card is in flow (phones)", () => {
    mockCardStyle("relative");
    renderSecondPageView();
    expect(screen.getByRole("region", REGION)).toBeInTheDocument();
    expect(barH()).toBe("");
  });

  it("moves focus to #main-content when the focused banner control hides", async () => {
    document.body.insertAdjacentHTML("beforeend", '<main id="main-content"></main>');
    const user = userEvent.setup();
    renderSecondPageView();
    await user.tab(); // dismiss button is first in DOM order
    expect(screen.getByRole("button", DISMISS)).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(document.getElementById("main-content")).toHaveFocus();
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
      mockCardStyle("fixed", "16px");
      const view = renderSecondPageView();
      expect(barH()).toBe("72px");
      height = 80;
      act(() => roCallback?.());
      expect(barH()).toBe("96px");
      view.unmount();
      expect(disconnect).toHaveBeenCalled();
      expect(barH()).toBe("");
    });

    it("uses the bare height when there is no bottom offset", () => {
      mockCardStyle("fixed");
      renderSecondPageView();
      expect(barH()).toBe("56px");
    });

    it("disconnects the observer on dismiss", async () => {
      mockCardStyle("fixed");
      renderSecondPageView();
      await userEvent.click(screen.getByRole("button", DISMISS));
      expect(disconnect).toHaveBeenCalled();
      expect(barH()).toBe("");
    });
  });
});
