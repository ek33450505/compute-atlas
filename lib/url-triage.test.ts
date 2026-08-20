import { describe, it, expect, vi, afterEach } from "vitest";

import { triageUrl } from "./url-triage";
import type { ResolveDeps } from "@/scripts/discovery/net-guard";

// Every hostname used below is a plain (non-IP-literal) name, so
// `isBlockedHost` alone never short-circuits `resolvesToBlockedAddress` —
// without injected resolvers this suite would fall through to REAL DNS.
// Mirrors the fixed fake-resolver pair used in
// scripts/discovery/fetch-page-text.test.ts.
const SAFE_RESOLVE_DEPS: ResolveDeps = {
  resolve4: vi.fn(async () => ["93.184.216.34"]),
  resolve6: vi.fn(async () => {
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  }),
};

function makeRedirectResponse(location: string): Response {
  return {
    status: 302,
    ok: false,
    headers: new Headers({ location }),
    body: null,
  } as unknown as Response;
}

describe("triageUrl total-timeout threading", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("threads an explicit totalTimeoutMs through to fetchPageText's wall-clock budget", async () => {
    // Deterministic elapsed-time simulation via Date.now() rather than real
    // sleeps (mirrors fetch-page-text.test.ts's own wall-clock-deadline
    // test): iteration 1 sees 15ms of budget remaining (proceeds), iteration
    // 2 sees 5ms remaining (proceeds), iteration 3 sees the budget already
    // exhausted and aborts BEFORE a third connection attempt.
    const dateNowSpy = vi.spyOn(Date, "now");
    const timeline = [1_000, 1_005, 1_015, 1_035];
    let call = 0;
    dateNowSpy.mockImplementation(() => timeline[Math.min(call++, timeline.length - 1)]);

    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      const hopNumber = Number(url.match(/\/hop(\d+)$/)?.[1] ?? "0");
      return makeRedirectResponse(`https://public.example.com/hop${hopNumber + 1}`);
    });

    const result = await triageUrl("https://public.example.com/hop0", {
      fetchImpl,
      timeoutMs: 10_000,
      totalTimeoutMs: 20,
      resolveDeps: SAFE_RESOLVE_DEPS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.error).toMatch(/budget/i);
    // Aborted on the 3rd deadline check, never issuing a 3rd request — proves
    // the explicit totalTimeoutMs (not the full MAX_REDIRECTS chain) is what
    // stopped it.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("defaults to TRIAGE_TOTAL_TIMEOUT_MS (10s) when totalTimeoutMs is not overridden", async () => {
    // Same deadline-check shape as above, but with no totalTimeoutMs passed
    // — a deadline exactly 10_000ms out proves the default constant (not
    // some other value, and not "no budget at all") is what's threaded
    // through by default.
    const dateNowSpy = vi.spyOn(Date, "now");
    const timeline = [1_000, 1_005, 11_005]; // second call still inside a 10s budget; third call is past it
    let call = 0;
    dateNowSpy.mockImplementation(() => timeline[Math.min(call++, timeline.length - 1)]);

    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      const hopNumber = Number(url.match(/\/hop(\d+)$/)?.[1] ?? "0");
      return makeRedirectResponse(`https://public.example.com/hop${hopNumber + 1}`);
    });

    const result = await triageUrl("https://public.example.com/hop0", {
      fetchImpl,
      timeoutMs: 10_000,
      resolveDeps: SAFE_RESOLVE_DEPS,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected ok:false");
    expect(result.error).toMatch(/budget/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not treat a fast, non-redirecting fetch as budget-exceeded (no false positive on the happy path)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      return {
        status: 200,
        ok: true,
        headers: new Headers({ "content-type": "text/html" }),
        body: {
          getReader: () => {
            let done = false;
            return {
              read: vi.fn(async () => {
                if (done) return { done: true, value: undefined };
                done = true;
                return { done: false, value: new TextEncoder().encode("<title>Hello</title><p>hi</p>") };
              }),
              cancel: vi.fn(async () => {}),
              releaseLock: vi.fn(),
            };
          },
        },
      } as unknown as Response;
    });

    const result = await triageUrl("https://public.example.com/ok", {
      fetchImpl,
      resolveDeps: SAFE_RESOLVE_DEPS,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    expect(result.title).toBe("Hello");
  });
});
