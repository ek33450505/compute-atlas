// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const redirectMock = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirectMock(url) }));

import SubscribeStoppedAllPage from "./page";

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

const props = (sp: { token?: string; state?: string }) => ({ searchParams: Promise.resolve(sp) });

describe("/subscribe/stopped-all", () => {
  beforeEach(() => {
    redirectMock.mockClear();
  });

  it("with a token: states the real scope (automated email, personal-reply exception) and renders Undo", async () => {
    const text = render(await SubscribeStoppedAllPage(props({ token: "tok" })));
    expect(text).toContain("automated email");
    expect(text).toContain("personal reply to a message you send us");
    expect(text).toContain("action=undo");
  });

  it("state=other: no Undo button, points to the original email and the contact page", async () => {
    const text = render(await SubscribeStoppedAllPage(props({ state: "other" })));
    expect(text).not.toContain("action=undo");
    expect(text).toContain("/contact");
  });

  it("neither token nor state: treated as an invalid link", async () => {
    await expect(SubscribeStoppedAllPage(props({}))).rejects.toThrow("/subscribe/invalid");
  });
});
