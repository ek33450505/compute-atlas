import { vi, describe, it, expect } from "vitest";

// vi.mock calls are hoisted above imports by Vitest — the mocks are active
// before the page module is loaded.  Only generateMetadata is under test;
// JSX and navigation helpers are only referenced in the default page export.

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("Not found");
  },
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

vi.mock("next/link", () => ({
  // Minimal stub — Link is only used in the default export, not generateMetadata
  default: ({ href, children }: { href: string; children: unknown }) => ({
    href,
    children,
  }),
}));

import { generateMetadata } from "./[slug]/page";

describe("generateMetadata", () => {
  it("includes the facility name, type, and location in the title", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "meta-prineville-or" }),
    });
    // toContain (not toBe) tolerates the operator-dedup branch — "Meta" is a
    // substring of the facility name, so the operator may be omitted — and
    // minor punctuation differences in the title template.
    expect(metadata.title).toContain("Meta Prineville Data Center Campus");
    expect(metadata.title).toContain("Prineville, OR");
    expect(metadata.title).toMatch(/data center/i);
  });

  it("returns a non-empty fallback title for an unknown slug and does not crash", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ slug: "this-slug-does-not-exist" }),
    });
    // Must return something meaningful and not throw
    expect(metadata.title).toBeTruthy();
    expect(typeof metadata.title).toBe("string");
    // Must not accidentally return a real facility name
    expect(metadata.title).not.toBe("Meta Prineville Data Center Campus");
  });
});
