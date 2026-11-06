import { describe, it, expect, vi } from "vitest";

const { permanentRedirect } = vi.hoisted(() => ({
  permanentRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));
vi.mock("next/navigation", () => ({ permanentRedirect }));

import ApiPage from "./page";

describe("withdrawn /api documentation page", () => {
  it("permanently redirects to /data", () => {
    expect(() => ApiPage()).toThrow("NEXT_REDIRECT:/data");
    expect(permanentRedirect).toHaveBeenCalledWith("/data");
  });
});
