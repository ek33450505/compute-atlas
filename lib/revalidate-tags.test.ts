import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockRevalidateTag } = vi.hoisted(() => ({ mockRevalidateTag: vi.fn() }));
vi.mock("next/cache", () => ({ revalidateTag: mockRevalidateTag }));

import { MAX_TAGS_PER_REQUEST } from "@/lib/cache-tags";
import { bustCacheTags } from "./revalidate-tags";

describe("bustCacheTags", () => {
  beforeEach(() => mockRevalidateTag.mockReset());

  it("busts each valid tag with the max profile", () => {
    expect(bustCacheTags(["facilities", "state:CA"])).toEqual({
      ok: true,
      tags: ["facilities", "state:CA"],
    });
    expect(mockRevalidateTag).toHaveBeenNthCalledWith(1, "facilities", "max");
    expect(mockRevalidateTag).toHaveBeenNthCalledWith(2, "state:CA", "max");
  });

  it("busts nothing if any tag is invalid", () => {
    expect(bustCacheTags(["facilities", "nope"])).toEqual({
      ok: false,
      error: "Invalid tag: nope",
    });
    expect(mockRevalidateTag).not.toHaveBeenCalled();
  });

  it("rejects non-string tags", () => {
    expect(bustCacheTags([42])).toEqual({ ok: false, error: "Invalid tag: 42" });
  });

  it("rejects more than the per-request cap", () => {
    const tags = Array.from({ length: MAX_TAGS_PER_REQUEST + 1 }, () => "facilities");
    expect(bustCacheTags(tags)).toEqual({
      ok: false,
      error: `Too many tags (max ${MAX_TAGS_PER_REQUEST})`,
    });
    expect(mockRevalidateTag).not.toHaveBeenCalled();
  });
});
