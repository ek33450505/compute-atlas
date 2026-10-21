// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

// The production default for the guarded fetchers is net-guard's `pinnedFetch`.
// These tests pin that wiring for fetchPageText, fetchPdfText, checkSources,
// triageUrl, verifySource's Wayback lookup and the three `buildRealDeps()`
// mains: a regression to the global `fetch` would pass every other suite,
// because they all inject their own fetchImpl. The Wayback defaults
// in verify-source.ts, verify-fields.ts and extract-fields.ts are each driven
// through their own function.
const { pinnedFetchMock, closableDeps } = vi.hoisted(() => ({
  pinnedFetchMock: vi.fn(),
  closableDeps: [] as Array<Record<string, unknown>>,
}));

vi.mock("./net-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./net-guard")>()),
  pinnedFetch: pinnedFetchMock,
  // checkSources builds its own pinned fetch (to attach the lookup rate gate and
  // own the Agent). Routing that factory to the same mock keeps the guard
  // meaningful, and the deps it receives are captured so a test can prove the
  // default is not built with permissive or overridden resolvers.
  createClosablePinnedFetch: (deps: Record<string, unknown>) => {
    closableDeps.push(deps);
    return { fetch: pinnedFetchMock, close: async () => {} };
  },
}));

// No real DNS for the pre-check (callers below pass no resolveDeps).
vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(async () => ["93.184.216.34"]),
  resolve6: vi.fn(async () => {
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  }),
}));

import { triageUrl } from "../../lib/url-triage";
import type { Facility } from "../../lib/schema";
import { checkSources } from "./check-sources";
import { fetchPageText } from "./fetch-page-text";
import { fetchPdfText } from "./fetch-pdf-text";
import { attemptArchiveRecovery as extractArchiveRecovery, buildRealDeps as buildExtractDeps } from "./extract-fields";
import { buildRealDeps as buildLeadsDeps } from "./leads-lane";
import { attemptArchiveRecovery as verifyFieldsArchiveRecovery, buildRealDeps as buildVerifyFieldsDeps } from "./verify-fields";
import { verifySource } from "./verify-source";

function globalFetchGuard() {
  const spy = vi.fn(async () => {
    throw new Error("global fetch must not be used");
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  closableDeps.length = 0;
  vi.unstubAllGlobals();
});

describe("production default fetch is pinnedFetch", () => {
  it("fetchPageText(url, {})", async () => {
    pinnedFetchMock.mockReset();
    pinnedFetchMock.mockResolvedValue(
      new Response("<html><body>hello</body></html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const globalSpy = globalFetchGuard();
    const result = await fetchPageText("https://example.com/", {});
    expect(result.ok).toBe(true);
    expect(pinnedFetchMock).toHaveBeenCalledTimes(1);
    expect(globalSpy).not.toHaveBeenCalled();
  });

  it("checkSources with no fetchImpl", async () => {
    pinnedFetchMock.mockReset();
    pinnedFetchMock.mockResolvedValue({ status: 200, headers: new Headers() });
    const globalSpy = globalFetchGuard();
    const facility = {
      id: "f",
      name: "F",
      sources: [{ url: "https://example.com/a", title: "t", retrievedAt: "2026-01-01" }],
    } as unknown as Facility;
    const [row] = await checkSources([facility], { concurrency: 1, timeoutMs: 2000 });
    expect(row.classification).toBe("ok");
    expect(pinnedFetchMock).toHaveBeenCalled();
    expect(globalSpy).not.toHaveBeenCalled();
    // Real resolvers only: no resolve4/resolve6 override (a stub could vet anything).
    const built = closableDeps.at(-1) as Record<string, unknown>;
    expect(built.resolve4).toBeUndefined();
    expect(built.resolve6).toBeUndefined();
    expect(typeof built.beforeResolve).toBe("function");
  });

  it("triageUrl(url) with no deps", async () => {
    pinnedFetchMock.mockReset();
    pinnedFetchMock.mockResolvedValue(
      new Response("<html><head><title>T</title></head><body>x</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const globalSpy = globalFetchGuard();
    const triage = await triageUrl("https://example.com/");
    expect(triage.ok).toBe(true);
    expect(pinnedFetchMock).toHaveBeenCalledTimes(1);
    expect(globalSpy).not.toHaveBeenCalled();
  });

  it("the Wayback availability lookup (verifySource, no fetchImpl)", async () => {
    pinnedFetchMock.mockReset();
    // "no snapshot": a 404 from the availability endpoint.
    pinnedFetchMock.mockResolvedValue(new Response("{}", { status: 404 }));
    const globalSpy = globalFetchGuard();
    const result = await verifySource(
      "https://example.com/page",
      { entityName: "Ridgeline Data Center" },
      {
        fetchPageTextImpl: async () => ({ ok: false, reason: "http_error", httpStatus: 403 }),
        callOllamaImpl: async () => {
          throw new Error("model must not be reached");
        },
      },
    );
    expect(result.reason).toContain("no Wayback snapshot available");
    expect(pinnedFetchMock).toHaveBeenCalledTimes(1);
    expect(String(pinnedFetchMock.mock.calls[0][0])).toContain("archive.org");
    expect(globalSpy).not.toHaveBeenCalled();
  });
});

describe("fetchPdfText default", () => {
  it("fetchPdfText(url, {}) uses pinnedFetch", async () => {
    pinnedFetchMock.mockReset();
    pinnedFetchMock.mockResolvedValue(new Response("x", { status: 200, headers: { "content-type": "text/html" } }));
    const globalSpy = globalFetchGuard();
    const result = await fetchPdfText("https://example.com/a.pdf", {});
    expect(result).toMatchObject({ ok: false, reason: "bad_content_type" });
    expect(pinnedFetchMock).toHaveBeenCalledTimes(1);
    expect(globalSpy).not.toHaveBeenCalled();
  });
});

// The mains' buildRealDeps(): page/PDF fetchers pinned, Wayback left to the
// pinned default (fetchImpl unset), Ollama (localhost) on the global fetch.
const mains: Array<[string, () => Record<string, unknown>]> = [
  ["verify-fields", () => buildVerifyFieldsDeps() as unknown as Record<string, unknown>],
  ["extract-fields", () => buildExtractDeps() as unknown as Record<string, unknown>],
  ["leads-lane", () => buildLeadsDeps() as unknown as Record<string, unknown>],
];

describe.each(mains)("%s buildRealDeps()", (name, build) => {
  const html = () =>
    new Response("<html><body>hello</body></html>", { status: 200, headers: { "content-type": "text/html" } });

  it("routes page fetches through pinnedFetch, never global fetch", async () => {
    pinnedFetchMock.mockReset();
    pinnedFetchMock.mockImplementation(async () => html());
    const globalSpy = globalFetchGuard();
    const deps = build() as { fetchPageTextImpl: (u: string) => Promise<unknown> };
    await deps.fetchPageTextImpl("https://example.com/");
    expect(pinnedFetchMock).toHaveBeenCalledTimes(1);
    expect(globalSpy).not.toHaveBeenCalled();
  });

  it.skipIf(name === "leads-lane")("routes PDF fetches through pinnedFetch", async () => {
    pinnedFetchMock.mockReset();
    pinnedFetchMock.mockImplementation(async () => html());
    const globalSpy = globalFetchGuard();
    const deps = build() as { fetchPdfTextImpl: (u: string) => Promise<unknown> };
    await deps.fetchPdfTextImpl("https://example.com/a.pdf");
    expect(pinnedFetchMock).toHaveBeenCalledTimes(1);
    expect(globalSpy).not.toHaveBeenCalled();
  });

  it("leaves the Wayback fetchImpl unset so the pinned default applies", () => {
    const deps = build();
    expect(deps.fetchImpl).toBeUndefined();
    expect(deps.rawFetchImpl).toBeUndefined();
  });

  it("keeps Ollama (localhost) on the global fetch, not pinnedFetch", async () => {
    pinnedFetchMock.mockReset();
    const globalSpy = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", globalSpy);
    const deps = build() as { callOllamaImpl: (o: object) => Promise<unknown> };
    await deps.callOllamaImpl({ systemPrompt: "s", userPrompt: "u", jsonSchema: {}, timeoutMs: 1000 });
    expect(globalSpy).toHaveBeenCalled();
    expect(pinnedFetchMock).not.toHaveBeenCalled();
  });
});

describe.each([
  ["verify-fields", verifyFieldsArchiveRecovery],
  ["extract-fields", extractArchiveRecovery],
] as const)("%s Wayback lookup default", (_name, attemptArchiveRecovery) => {
  it("attemptArchiveRecovery with no fetchImpl uses pinnedFetch for archive.org", async () => {
    pinnedFetchMock.mockReset();
    pinnedFetchMock.mockResolvedValue(new Response("{}", { status: 404 })); // no snapshot
    const globalSpy = globalFetchGuard();
    const result = await attemptArchiveRecovery(
      "https://example.com/page",
      { sleep: async () => {} } as never,
      {} as never,
    );
    expect(result).toBeNull();
    expect(pinnedFetchMock).toHaveBeenCalledTimes(1);
    expect(String(pinnedFetchMock.mock.calls[0][0])).toContain("archive.org");
    expect(globalSpy).not.toHaveBeenCalled();
  });
});
