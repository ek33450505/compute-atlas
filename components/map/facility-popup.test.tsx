import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { FacilityPopup, __clearFacilityPopupCache } from "./facility-popup";
import { toPopupSummary, type PopupSummary } from "@/lib/facility-slim";
import type { Facility } from "@/lib/schema";

// next/link renders to <a> — mock to avoid Next.js router-context dependency in jsdom.
// target/rel/aria-label are forwarded (not just href/className/children) so the
// linksOpenInNewTab tests below can assert on the real anchor attributes next/link
// would produce.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
    target,
    rel,
    "aria-label": ariaLabel,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    target?: string;
    rel?: string;
    "aria-label"?: string;
  }) => (
    <a href={href} className={className} target={target} rel={rel} aria-label={ariaLabel}>
      {children}
    </a>
  ),
}));

const fixture: Facility = {
  id: "test-facility",
  name: "Test Facility",
  operator: "Test Operator",
  status: "operational",
  facilityType: "data_center",
  aiClassification: "confirmed",
  confidence: "confirmed",
  location: { lat: 35.0, lon: -90.0, city: "Memphis", state: "TN", precision: "exact" },
  capacityMw: { operational: 100 },
  statusHistory: [],
  sources: [
    {
      url: "https://example.com",
      label: "Example News",
      retrievedAt: "2024-01-01",
      kind: "press",
    },
  ],
  lastUpdated: "2024-01-01",
};

const summary: PopupSummary = toPopupSummary(fixture, {
  nearestWater: { name: "Nonconnah Creek", kind: "river", distanceMi: 0.7 },
});
const summaryNoSiting: PopupSummary = toPopupSummary(fixture);

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function stubFetch(body: PopupSummary = summary) {
  fetchMock = vi.fn().mockResolvedValue(okResponse(body));
  vi.stubGlobal("fetch", fetchMock);
}

async function renderLoaded(props: Partial<React.ComponentProps<typeof FacilityPopup>> = {}) {
  const utils = render(<FacilityPopup id="test-facility" onClose={() => {}} {...props} />);
  await screen.findByText("Test Operator");
  return utils;
}

beforeEach(() => {
  __clearFacilityPopupCache();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FacilityPopup", () => {
  it("renders name, operator, status, capacity and city/state from the fetched summary", async () => {
    await renderLoaded();
    expect(screen.getByText("Test Facility")).toBeInTheDocument();
    expect(screen.getByText("Test Operator")).toBeInTheDocument();
    expect(screen.getByText("Operational")).toBeInTheDocument();
    expect(screen.getByText("100 MW operational")).toBeInTheDocument();
    expect(screen.getByText("Memphis, TN")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/map/facility/test-facility");
  });

  it("url-encodes the id in the request path", async () => {
    render(<FacilityPopup id="a/b" onClose={() => {}} />);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/map/facility/a%2Fb");
    await screen.findByText("Test Operator");
  });

  it("does not render capacity when absent", async () => {
    stubFetch({ ...summary, capacityMw: undefined });
    await renderLoaded();
    expect(screen.queryByText(/MW operational/)).not.toBeInTheDocument();
  });

  it("source link has rel noreferrer noopener and accessible name with 'opens in new tab'", async () => {
    await renderLoaded();
    const sourceLink = screen.getByRole("link", { name: /opens in new tab/i });
    expect(sourceLink).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("pressing Escape calls onClose", async () => {
    const onClose = vi.fn();
    await renderLoaded({ onClose });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pressing Escape calls onClose while still loading", () => {
    fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    render(<FacilityPopup id="test-facility" onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders a siting-distance cue when the summary carries nearestWater", async () => {
    await renderLoaded();
    expect(screen.getByText(/Nonconnah Creek/)).toBeInTheDocument();
    expect(screen.getByText(/0\.7 mi/)).toBeInTheDocument();
  });

  it("renders no siting cue for a summary without siting context", async () => {
    stubFetch(summaryNoSiting);
    await renderLoaded();
    expect(screen.queryByText(/mi —/)).not.toBeInTheDocument();
  });

  it("close button meets the 24px WCAG 2.5.8 floor via explicit h-7 w-7 (28px) sizing", () => {
    render(<FacilityPopup id="test-facility" onClose={() => {}} />);
    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton.className).toContain("h-7");
    expect(closeButton.className).toContain("w-7");
  });

  it("footer links are padded to a 24px+ tall target (not exempt as inline prose links)", async () => {
    await renderLoaded();
    expect(screen.getByRole("link", { name: "View details →" }).className).toContain(
      "py-1.5"
    );
    expect(screen.getByRole("link", { name: /opens in new tab/i }).className).toContain(
      "py-1.5"
    );
  });

  describe("loading, error and cache", () => {
    function deferred() {
      let resolve!: (r: Response) => void;
      const promise = new Promise<Response>((r) => (resolve = r));
      return { promise, resolve };
    }
    const summaryFor = (id: string, name: string): PopupSummary => ({
      ...summary,
      id,
      name,
      operator: `${name} Operator`,
    });

    it.each([
      ["A then B", ["A", "B"]],
      ["B then A", ["B", "A"]],
    ])("shows only the current id's content when responses resolve %s", async (_label, order) => {
      const a = deferred();
      const b = deferred();
      fetchMock = vi.fn((url: string) => (url.endsWith("/A") ? a.promise : b.promise));
      vi.stubGlobal("fetch", fetchMock);
      const { rerender } = render(<FacilityPopup id="A" onClose={() => {}} />);
      rerender(<FacilityPopup id="B" onClose={() => {}} />);
      const respond = {
        A: () => a.resolve(okResponse(summaryFor("A", "Alpha"))),
        B: () => b.resolve(okResponse(summaryFor("B", "Beta"))),
      };
      for (const k of order as ("A" | "B")[]) {
        await act(async () => respond[k]());
      }
      expect(await screen.findByText("Beta Operator")).toBeInTheDocument();
      expect(screen.queryByText("Alpha Operator")).not.toBeInTheDocument();
      expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    });

    it("does not cache a response that arrives after its request was aborted", async () => {
      const a = deferred();
      fetchMock = vi.fn().mockReturnValueOnce(a.promise).mockReturnValue(new Promise(() => {}));
      vi.stubGlobal("fetch", fetchMock);
      const { rerender } = render(<FacilityPopup id="A" onClose={() => {}} />);
      rerender(<FacilityPopup id="B" onClose={() => {}} />);
      await act(async () => a.resolve(okResponse(summaryFor("A", "Alpha"))));
      rerender(<FacilityPopup id="A" onClose={() => {}} />);
      // A was discarded, so reopening it fetches again rather than showing stale data.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(screen.queryByText("Alpha Operator")).not.toBeInTheDocument();
    });

    it("a response resolving after unmount causes no error and no state update", async () => {
      const a = deferred();
      fetchMock = vi.fn().mockReturnValue(a.promise);
      vi.stubGlobal("fetch", fetchMock);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { unmount } = render(<FacilityPopup id="A" onClose={() => {}} />);
      unmount();
      await act(async () => a.resolve(okResponse(summaryFor("A", "Alpha"))));
      expect(errorSpy).not.toHaveBeenCalled();
      // Discarded, not cached: nothing was written for the unmounted request.
      render(<FacilityPopup id="A" onClose={() => {}} />);
      expect(screen.queryByText("Alpha Operator")).not.toBeInTheDocument();
    });

    it("falls back to a neutral header after a failed fetch with no initial", async () => {
      fetchMock = vi.fn().mockRejectedValue(new TypeError("network"));
      vi.stubGlobal("fetch", fetchMock);
      render(<FacilityPopup id="test-facility" onClose={() => {}} />);
      expect(await screen.findByText("Facility details")).toBeInTheDocument();
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    });

    it("announces the failure line through a status live region", async () => {
      fetchMock = vi.fn().mockRejectedValue(new TypeError("network"));
      vi.stubGlobal("fetch", fetchMock);
      const failing = deferred();
      fetchMock = vi.fn().mockReturnValue(failing.promise);
      vi.stubGlobal("fetch", fetchMock);
      render(<FacilityPopup id="test-facility" onClose={() => {}} />);
      // Present and empty before the failure, so it is registered as a live region.
      expect(screen.getByRole("status")).toBeEmptyDOMElement();
      // display:none would drop the region from the accessibility tree.
      expect(screen.getByRole("status").className).not.toMatch(/hidden/);
      await act(async () => failing.resolve({ ok: false, status: 500 } as Response));
      expect(screen.getByRole("status")).toHaveTextContent("Details unavailable.");
    });

    it("renders Close (focused) and View details immediately, before the fetch resolves, with the body aria-busy", () => {
      fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
      vi.stubGlobal("fetch", fetchMock);
      render(<FacilityPopup id="test-facility" onClose={() => {}} />);
      expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
      const link = screen.getByRole("link", { name: "View details →" });
      expect(link).toHaveAttribute("href", "/facilities/test-facility");
      expect(screen.getByText("Loading…")).toBeInTheDocument();
      expect(link.closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    });

    it("clears aria-busy once content has loaded", async () => {
      await renderLoaded();
      expect(screen.getByRole("link", { name: "View details →" }).closest("[aria-busy]")).toHaveAttribute(
        "aria-busy",
        "false"
      );
    });

    it("shows 'Details unavailable.' and still offers View details on a non-OK response", async () => {
      fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
      vi.stubGlobal("fetch", fetchMock);
      render(<FacilityPopup id="test-facility" onClose={() => {}} />);
      expect(await screen.findByText("Details unavailable.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "View details →" })).toBeInTheDocument();
    });

    it("shows 'Details unavailable.' when the request rejects", async () => {
      fetchMock = vi.fn().mockRejectedValue(new TypeError("network"));
      vi.stubGlobal("fetch", fetchMock);
      render(<FacilityPopup id="test-facility" onClose={() => {}} />);
      expect(await screen.findByText("Details unavailable.")).toBeInTheDocument();
    });

    it("does not refetch when the same id is opened again", async () => {
      const first = await renderLoaded();
      first.unmount();
      render(<FacilityPopup id="test-facility" onClose={() => {}} />);
      expect(screen.getByText("Test Operator")).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("aborts the in-flight request on unmount", () => {
      fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
      vi.stubGlobal("fetch", fetchMock);
      const { unmount } = render(<FacilityPopup id="test-facility" onClose={() => {}} />);
      const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
      expect(signal.aborted).toBe(false);
      unmount();
      expect(signal.aborted).toBe(true);
    });

    it("aborts the old request and fetches the new id when the id changes", () => {
      fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
      vi.stubGlobal("fetch", fetchMock);
      const { rerender } = render(<FacilityPopup id="one" onClose={() => {}} />);
      const firstSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
      rerender(<FacilityPopup id="two" onClose={() => {}} />);
      expect(firstSignal.aborted).toBe(true);
      expect(fetchMock.mock.calls[1][0]).toBe("/api/map/facility/two");
    });
  });

  describe("import-graph guard", () => {
    // The siting-context JSON (~1.3 MB) must never reach the client bundle via
    // the map. Follows value imports (not `import type`) transitively.
    const ROOT = process.cwd();
    const FORBIDDEN = new Set([
      join(ROOT, "lib/siting-context.ts"),
      join(ROOT, "data/siting-context.json"),
    ]);
    const IMPORT_RE =
      /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

    function resolveLocal(spec: string, fromFile: string): string | null {
      let base: string;
      if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
      else if (spec.startsWith(".")) base = join(dirname(fromFile), spec);
      else return null;
      for (const candidate of [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        join(base, "index.ts"),
        join(base, "index.tsx"),
      ]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      }
      return null;
    }

    function reachable(entry: string): Set<string> {
      const seen = new Set<string>();
      const queue = [entry];
      while (queue.length) {
        const file = queue.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        if (!/\.tsx?$/.test(file)) continue;
        const src = readFileSync(file, "utf8");
        for (const m of src.matchAll(IMPORT_RE)) {
          const target = resolveLocal(m[1] ?? m[2], file);
          if (target) queue.push(target);
        }
      }
      return seen;
    }

    it.each(["components/map/facility-popup.tsx", "components/map/facility-map.tsx"])(
      "%s does not transitively import the siting-context module or JSON",
      (entry) => {
        const graph = reachable(join(ROOT, entry));
        // Sanity: the walk really followed imports (guards against a regex
        // that matches nothing and passes vacuously).
        expect(graph.has(join(ROOT, "lib/siting-format.ts"))).toBe(true);
        expect([...graph].filter((f) => FORBIDDEN.has(f))).toEqual([]);
      }
    );
  });

  describe("linksOpenInNewTab (embed frame-escape)", () => {
    it("defaults to a same-tab 'View details' link with no target attribute", async () => {
      await renderLoaded();
      const link = screen.getByRole("link", { name: "View details →" });
      expect(link).not.toHaveAttribute("target");
      expect(link).not.toHaveAttribute("rel");
    });

    it("opens 'View details' in a new top-level tab when linksOpenInNewTab is set", async () => {
      await renderLoaded({ linksOpenInNewTab: true });
      const link = screen.getByRole("link", { name: /view details/i });
      expect(link).toHaveAttribute("target", "_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
      // Accessible name follows the repo's existing "(opens in new tab)"
      // convention (see the source link's aria-label a few lines below it).
      expect(link).toHaveAccessibleName(/opens in new tab/i);
    });
  });

  it("caps the card's max-width responsively so it can't overflow a narrow viewport", async () => {
    await renderLoaded();
    const headerRow = screen.getByText("Test Facility").closest("div")!;
    const card = headerRow.parentElement!;
    expect(card.className).toContain("max-w-[min(280px,calc(100vw-5rem))]");
  });

  describe("scrollable body — measured max-height", () => {
    // Same pattern as facility-map.test.tsx's "Tools Panel — measured-top
    // scroll cap" tests: getBoundingClientRect and window.innerHeight are
    // mocked so the resulting inline maxHeight is deterministic.
    function bodyOf(): HTMLElement {
      return screen.getByRole("link", { name: "View details →" }).closest("[aria-busy]") as HTMLElement;
    }

    it("caps the body to the measured space below it (window fallback when not nested in a map)", async () => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 200, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => {} } as DOMRect);
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(390);

      await renderLoaded();
      // Math.max(0, 390 - 200 - 20) = 170
      expect(bodyOf().style.maxHeight).toBe("170px");
    });

    it("clamps the cap to 0 rather than exceeding the real available space", async () => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 500, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => {} } as DOMRect);
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(390);

      await renderLoaded();
      // Math.max(0, 390 - 500 - 20) = 0
      expect(bodyOf().style.maxHeight).toBe("0px");
    });

    it("bounds the cap against the map's own container edge when nested inside one, not the window", async () => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 300, bottom: 350, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => {} } as DOMRect);
      // Deliberately far off from the expected 30px result, to prove the
      // map container's own bottom edge is used instead of window height.
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);

      render(
        <div className="maplibregl-map">
          <FacilityPopup id="test-facility" onClose={() => {}} />
        </div>
      );
      await screen.findByText("Test Operator");
      // Math.max(0, 350 - 300 - 20) = 30
      expect(bodyOf().style.maxHeight).toBe("30px");
    });
  });
});
