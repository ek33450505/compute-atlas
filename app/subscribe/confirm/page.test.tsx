// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});
vi.mock("next/navigation", () => ({ redirect: (p: string) => redirectMock(p) }));

import SubscribeConfirmPage, { metadata } from "./page";

const props = (token?: string) => ({ searchParams: Promise.resolve({ token }) });

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

describe("/subscribe/confirm interstitial", () => {
  it("is noindex/nofollow with no referrer", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe("no-referrer");
  });

  it("renders a POST form carrying the encoded token, and a Not now link", async () => {
    const text = render(await SubscribeConfirmPage(props("a b/c+d")));
    expect(text).toContain('"method":"post"');
    expect(text).toContain(`"action":"/api/subscribe/confirm?token=${encodeURIComponent("a b/c+d")}"`);
    expect(text).toContain("Confirm your watch");
    expect(text).toContain("Not now");
    expect(text).toContain('"href":"/"');
  });

  it("redirects to /subscribe/invalid when the token is missing", async () => {
    await expect(SubscribeConfirmPage(props())).rejects.toThrow("NEXT_REDIRECT:/subscribe/invalid");
  });
});
