// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirectMock(url) }));
const stateMock = vi.fn();
vi.mock("@/lib/subscribe", () => ({ stopAllStateByToken: (t: string) => stateMock(t) }));

import SubscribeStopAllPage from "./page";

const props = (token: string) => ({ searchParams: Promise.resolve({ token }) });

function render(el: unknown): string {
  const seen = new Set<unknown>();
  return JSON.stringify(el, (_k, v) => {
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return undefined;
      seen.add(v);
    }
    return v;
  });
}

describe("/subscribe/stop-all by stop-all state", () => {
  beforeEach(() => {
    redirectMock.mockClear();
    stateMock.mockReset();
  });

  it("stopped_by_this: redirects to the Undo page", async () => {
    stateMock.mockResolvedValue("stopped_by_this");
    await expect(SubscribeStopAllPage(props("tok"))).rejects.toThrow("/subscribe/stopped-all?token=tok");
  });

  it("stopped_by_other: redirects to 'already stopped' without a token in the URL", async () => {
    stateMock.mockResolvedValue("stopped_by_other");
    await expect(SubscribeStopAllPage(props("tok"))).rejects.toThrow("/subscribe/stopped-all?state=other");
  });

  it("not_stopped: renders the Stop form, no redirect", async () => {
    stateMock.mockResolvedValue("not_stopped");
    const text = render(await SubscribeStopAllPage(props("tok")));
    expect(text).toContain("scope=all");
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("error: falls back to the Stop form (its POST re-checks), no redirect", async () => {
    stateMock.mockResolvedValue("error");
    const text = render(await SubscribeStopAllPage(props("tok")));
    expect(text).toContain("scope=all");
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
