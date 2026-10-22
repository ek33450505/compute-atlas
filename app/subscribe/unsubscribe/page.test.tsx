// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const unsubscribedMock = vi.fn();
vi.mock("@/lib/subscribe", () => ({ isTokenRowUnsubscribed: (t: string) => unsubscribedMock(t) }));

import SubscribeUnsubscribeConfirmPage from "./page";

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

describe("/subscribe/unsubscribe interstitial", () => {
  beforeEach(() => {
    unsubscribedMock.mockReset();
  });

  it("offers Unsubscribe (POST) while the row is active", async () => {
    unsubscribedMock.mockResolvedValue(false);
    const text = render(await SubscribeUnsubscribeConfirmPage(props("tok")));
    expect(text).toContain("Unsubscribe from this subscription?");
    expect(text).not.toContain("action=resume");
  });

  it("offers Resume (POST) once the row is already unsubscribed", async () => {
    unsubscribedMock.mockResolvedValue(true);
    const text = render(await SubscribeUnsubscribeConfirmPage(props("tok")));
    expect(text).toContain("Already unsubscribed");
    expect(text).toContain("action=resume");
  });
});
