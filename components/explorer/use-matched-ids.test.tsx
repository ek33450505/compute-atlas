import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { StrictMode, type ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
import {
  buildMatchQuery,
  useMatchedIds,
  MAX_OPERATORS_PER_REQUEST,
} from "./use-matched-ids";

type Deferred = { resolve: (ids: unknown) => void; reject: () => void; signal?: AbortSignal; url: string };

let fetchMock: Mock;
let pendingFetches: Deferred[];
/** When false, aborting does not reject the promise (a transport that ignores the signal). */
let rejectOnAbort = true;

/** Installs a fetch whose responses the test settles by hand. */
function installManualFetch() {
  pendingFetches = [];
  fetchMock = vi.fn((url: string, init?: { signal?: AbortSignal }) => {
    return new Promise<Response>((resolve, reject) => {
      const d: Deferred = {
        url,
        signal: init?.signal,
        resolve: (ids) => resolve(new Response(JSON.stringify({ ids }), { status: 200 })),
        reject: () => resolve(new Response("x", { status: 500 })),
      };
      init?.signal?.addEventListener("abort", () => {
        if (rejectOnAbort) reject(new DOMException("aborted", "AbortError"));
      });
      pendingFetches.push(d);
    });
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function advance(ms = 300) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function settle(i: number, ids: unknown) {
  await act(async () => {
    pendingFetches[i].resolve(ids);
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  rejectOnAbort = true;
  installManualFetch();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildMatchQuery", () => {
  it("is empty when there is no operator and minMw is 0", () => {
    expect(buildMatchQuery([], 0)).toBe("");
  });
  it("sorts operators for a stable key", () => {
    expect(buildMatchQuery(["Zed", "Acme"], 0)).toBe("operator=Acme&operator=Zed");
  });
  it("encodes commas inside operator names", () => {
    expect(buildMatchQuery(["Zed, Inc."], 0)).toBe("operator=Zed%2C+Inc.");
  });
  it("omits minMw at 0 and includes it above", () => {
    expect(buildMatchQuery(["A"], 0)).not.toContain("minMw");
    expect(buildMatchQuery(["A"], 100)).toBe("operator=A&minMw=100");
    expect(buildMatchQuery([], 500)).toBe("minMw=500");
  });
});

describe("useMatchedIds", () => {
  it("is idle and never fetches when neither filter is active", async () => {
    const { result } = renderHook(() => useMatchedIds([], 0));
    await advance(1000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toEqual({ ids: null, pending: false, error: false });
  });

  it("is pending with no ids until the first lookup resolves, then returns them", async () => {
    const { result } = renderHook(() => useMatchedIds(["A"], 0));
    expect(result.current).toEqual({ ids: null, pending: true, error: false });
    await advance();
    await settle(0, ["x", "y"]);
    expect(result.current.pending).toBe(false);
    expect([...result.current.ids!].sort()).toEqual(["x", "y"]);
  });

  it("debounces A -> B -> C into one request for C", async () => {
    const { rerender } = renderHook(({ ops }) => useMatchedIds(ops, 0), {
      initialProps: { ops: ["A"] },
    });
    await advance(100);
    rerender({ ops: ["B"] });
    await advance(100);
    rerender({ ops: ["C"] });
    await advance(300);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/map/match?operator=C");
  });

  it("keeps the previous ids while the next query is pending", async () => {
    const { result, rerender } = renderHook(({ ops }) => useMatchedIds(ops, 0), {
      initialProps: { ops: ["A"] },
    });
    await advance();
    await settle(0, ["a1"]);
    rerender({ ops: ["B"] });
    expect(result.current.pending).toBe(true);
    expect([...result.current.ids!]).toEqual(["a1"]);
    await advance();
    await settle(1, ["b1"]);
    expect([...result.current.ids!]).toEqual(["b1"]);
    expect(result.current.pending).toBe(false);
  });

  it("aborts a superseded in-flight request", async () => {
    const { rerender } = renderHook(({ ops }) => useMatchedIds(ops, 0), {
      initialProps: { ops: ["A"] },
    });
    await advance();
    const first = pendingFetches[0];
    rerender({ ops: ["B"] });
    expect(first.signal?.aborted).toBe(true);
  });

  it("aborts the in-flight request on unmount", async () => {
    const { unmount } = renderHook(() => useMatchedIds(["A"], 0));
    await advance();
    unmount();
    expect(pendingFetches[0].signal?.aborted).toBe(true);
  });

  it("serves a return to an already-resolved query from cache: no fetch, no wait", async () => {
    const { result, rerender } = renderHook(({ ops }) => useMatchedIds(ops, 0), {
      initialProps: { ops: ["A"] },
    });
    await advance();
    await settle(0, ["a1"]);
    rerender({ ops: ["B"] });
    await advance();
    await settle(1, ["b1"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    rerender({ ops: ["A"] });
    // No timers advanced: the cache hit resolves synchronously within the effect.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([...result.current.ids!]).toEqual(["a1"]);
    expect(result.current.pending).toBe(false);
  });

  it("ignores a stale success that lands after the key changed", async () => {
    rejectOnAbort = false;
    const { result, rerender } = renderHook(({ ops }) => useMatchedIds(ops, 0), {
      initialProps: { ops: ["A"] },
    });
    await advance();
    const stale = pendingFetches[0];
    rerender({ ops: ["B"] });
    // The aborted request's late body must not become the result for B.
    await act(async () => {
      stale.resolve(["stale"]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.ids).toBeNull();
    expect(result.current.pending).toBe(true);
    await advance();
    await settle(1, ["fresh"]);
    expect([...result.current.ids!]).toEqual(["fresh"]);
  });

  it("reports an error (and warns) on a non-ok response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useMatchedIds(["A"], 0));
    await advance();
    await act(async () => {
      pendingFetches[0].reject();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toEqual({ ids: null, pending: false, error: true });
    expect(warn).toHaveBeenCalled();
  });

  it("reports an error on a malformed body and drops non-string ids", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useMatchedIds(["A"], 0));
    await advance();
    await settle(0, "not-an-array");
    expect(result.current.error).toBe(true);
    expect(warn).toHaveBeenCalled();

    const second = renderHook(() => useMatchedIds(["B"], 0));
    await advance();
    await settle(1, ["ok", 5, null, { a: 1 }, "also"]);
    expect([...second.result.current.ids!].sort()).toEqual(["also", "ok"]);
  });

  it("clears the previous result when the filters are cleared", async () => {
    const { result, rerender } = renderHook(({ ops }) => useMatchedIds(ops, 0), {
      initialProps: { ops: ["A"] },
    });
    await advance();
    await settle(0, ["a1"]);
    rerender({ ops: [] });
    expect(result.current).toEqual({ ids: null, pending: false, error: false });
    rerender({ ops: ["B"] });
    expect(result.current.ids).toBeNull();
  });

  it("makes one request per key under StrictMode", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    renderHook(() => useMatchedIds(["A"], 0), { wrapper });
    await advance();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("splits more than 25 operators into chunked requests and unions the ids", async () => {
    const ops = Array.from({ length: 30 }, (_, i) => `op${String(i).padStart(2, "0")}`);
    const { result } = renderHook(() => useMatchedIds(ops, 100));
    await advance();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const urls = fetchMock.mock.calls.map((c) => new URL(String(c[0]), "http://x"));
    const sizes = urls.map((u) => u.searchParams.getAll("operator").length).sort((a, b) => a - b);
    expect(sizes).toEqual([30 - MAX_OPERATORS_PER_REQUEST, MAX_OPERATORS_PER_REQUEST]);
    for (const u of urls) expect(u.searchParams.get("minMw")).toBe("100");
    // Together the chunks cover every selected operator exactly once.
    expect(urls.flatMap((u) => u.searchParams.getAll("operator")).sort()).toEqual(ops);

    await settle(0, ["a", "b"]);
    expect(result.current.pending).toBe(true);
    await settle(1, ["b", "c"]);
    expect([...result.current.ids!].sort()).toEqual(["a", "b", "c"]);
  });

  it("flags an error when any chunk fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ops = Array.from({ length: 30 }, (_, i) => `op${i}`);
    const { result } = renderHook(() => useMatchedIds(ops, 0));
    await advance();
    await settle(0, ["a"]);
    await act(async () => {
      pendingFetches[1].reject();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toEqual({ ids: null, pending: false, error: true });
  });
});
