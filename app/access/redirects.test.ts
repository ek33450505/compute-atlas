import { describe, it, expect, vi } from "vitest";

const { permanentRedirect } = vi.hoisted(() => ({
  permanentRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));
vi.mock("next/navigation", () => ({ permanentRedirect }));

import AccessPage from "./page";
import AccessConfirmedPage from "./confirmed/page";
import AccessInvalidPage from "./invalid/page";

describe("withdrawn /access pages", () => {
  it.each([
    ["/access", AccessPage],
    ["/access/confirmed", AccessConfirmedPage],
    ["/access/invalid", AccessInvalidPage],
  ])("%s permanently redirects to /contact", (_path, Page) => {
    permanentRedirect.mockClear();
    expect(() => Page()).toThrow("NEXT_REDIRECT:/contact");
    expect(permanentRedirect).toHaveBeenCalledWith("/contact");
  });
});
