// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { canTransition, datasetRequestInputSchema, normalizeDatasetNote } from "@/lib/dataset-grants";
import { hasUnstorableChars } from "@/lib/intake-fields";
import { isDatasetSharingEnabled } from "@/lib/dataset-flag";
import { DATASET_GRANT_STATUSES, type DatasetGrantStatus } from "@/lib/db/schema";

const ALLOWED: ReadonlyArray<readonly [DatasetGrantStatus, DatasetGrantStatus]> = [
  ["unverified", "pending_review"],
  ["pending_review", "active"],
  ["pending_review", "rejected"],
  ["active", "expired"],
  ["active", "revoked"],
];

describe("canTransition", () => {
  const pairs = DATASET_GRANT_STATUSES.flatMap((from) =>
    DATASET_GRANT_STATUSES.map((to) => [from, to] as const)
  );

  it("covers every (from, to) pair", () => {
    expect(pairs).toHaveLength(36);
  });

  it.each(pairs)("%s -> %s", (from, to) => {
    const expected = ALLOWED.some(([f, t]) => f === from && t === to);
    expect(canTransition(from, to)).toBe(expected);
  });

  it("allows exactly five transitions", () => {
    expect(pairs.filter(([from, to]) => canTransition(from, to))).toHaveLength(5);
  });
});

describe("datasetRequestInputSchema", () => {
  const valid = {
    email: "reporter@example.com",
    name: "Pat Reporter",
    category: "journalist",
    intendedUse: "Cross-checking siting announcements for a story.",
    attributionAck: true,
    termsAccepted: true,
  };

  it("accepts a valid body, defaults links to [] and trims text fields", () => {
    const parsed = datasetRequestInputSchema.safeParse({
      ...valid,
      name: "  Pat Reporter  ",
      organization: "  The Gazette ",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.links).toEqual([]);
      expect(parsed.data.name).toBe("Pat Reporter");
      expect(parsed.data.organization).toBe("The Gazette");
    }
  });

  it("accepts up to three http(s) links", () => {
    const links = ["https://example.com/a", "http://example.org/b", "https://example.net/c"];
    expect(datasetRequestInputSchema.safeParse({ ...valid, links }).success).toBe(true);
  });

  it("rejects more than three links", () => {
    const links = [1, 2, 3, 4].map((n) => `https://example.com/${n}`);
    expect(datasetRequestInputSchema.safeParse({ ...valid, links }).success).toBe(false);
  });

  it("rejects a javascript: link", () => {
    expect(
      datasetRequestInputSchema.safeParse({ ...valid, links: ["javascript:alert(1)"] }).success
    ).toBe(false);
  });

  it.each([
    ["attributionAck false", { attributionAck: false }],
    ["attributionAck missing", { attributionAck: undefined }],
    ["termsAccepted false", { termsAccepted: false }],
    ["termsAccepted missing", { termsAccepted: undefined }],
    ["unknown category", { category: "wizard" }],
    ["empty name", { name: "   " }],
    ["intendedUse over 2000", { intendedUse: "x".repeat(2001) }],
    ["empty intendedUse", { intendedUse: "" }],
    ["bad email", { email: "not-an-email" }],
  ])("rejects %s", (_label, override) => {
    expect(datasetRequestInputSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });

  it("accepts intendedUse of exactly 2000 characters", () => {
    expect(
      datasetRequestInputSchema.safeParse({ ...valid, intendedUse: "x".repeat(2000) }).success
    ).toBe(true);
  });

  // NUL and an unpaired surrogate pass Zod's string check but fail at the Postgres insert as an uncaught 500.
  describe.each(["name", "organization", "role", "intendedUse"] as const)("%s: unstorable characters", (field) => {
    it.each([["NUL", "a\u0000b"], ["lone high surrogate", "\ud800"], ["lone low surrogate", "x\udc00y"]])(
      "rejects a %s with the shared message",
      (_label, bad) => {
        const parsed = datasetRequestInputSchema.safeParse({ ...valid, [field]: bad });
        expect(parsed.success).toBe(false);
        if (!parsed.success) {
          expect(parsed.error.issues).toEqual([
            expect.objectContaining({ path: [field], message: "Remove unsupported characters." }),
          ]);
        }
      }
    );

    it("accepts a valid surrogate pair and non-ASCII text", () => {
      expect(datasetRequestInputSchema.safeParse({ ...valid, [field]: "Zoë 😀 数据" }).success).toBe(true);
    });
  });

  it("keeps organization and role optional", () => {
    const parsed = datasetRequestInputSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.organization).toBeUndefined();
      expect(parsed.data.role).toBeUndefined();
    }
  });
});

describe("isDatasetSharingEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is true only for the exact string 'true'", () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", "true");
    expect(isDatasetSharingEnabled()).toBe(true);
    for (const value of ["", "1", "TRUE", "True", "yes", " true", "false"]) {
      vi.stubEnv("DATASET_SHARING_ENABLED", value);
      expect(isDatasetSharingEnabled()).toBe(false);
    }
  });

  it("is false when unset", () => {
    vi.stubEnv("DATASET_SHARING_ENABLED", undefined);
    expect(isDatasetSharingEnabled()).toBe(false);
  });
});

describe("normalizeDatasetNote", () => {
  it("trims, and maps empty, whitespace-only, null and undefined to null", () => {
    expect(normalizeDatasetNote("  a note  ")).toBe("a note");
    for (const empty of ["", "   ", "\n\t ", null, undefined]) {
      expect(normalizeDatasetNote(empty)).toBeNull();
    }
  });

  it("caps at 2000 characters and keeps exactly 2000 intact", () => {
    expect(normalizeDatasetNote("x".repeat(2000))).toBe("x".repeat(2000));
    expect(normalizeDatasetNote("x".repeat(2001))).toBe("x".repeat(2000));
    expect(normalizeDatasetNote(`  ${"y".repeat(2500)}  `)).toBe("y".repeat(2000));
  });

  it("strips a NUL anywhere in the note, and a note that is only NULs and whitespace becomes null", () => {
    expect(normalizeDatasetNote("a\u0000b")).toBe("ab");
    expect(normalizeDatasetNote("\u0000lead and trail\u0000")).toBe("lead and trail");
    expect(normalizeDatasetNote("  \u0000  ")).toBeNull();
  });

  it("strips unpaired surrogates but keeps a valid pair and non-ASCII text", () => {
    expect(normalizeDatasetNote("a\ud800b\udc00c")).toBe("abc");
    expect(normalizeDatasetNote("Zoë 😀 数据")).toBe("Zoë 😀 数据");
  });

  it("caps at 2000 CODE POINTS, never splitting a surrogate pair", () => {
    const capped = normalizeDatasetNote("😀".repeat(2001));

    expect(capped).not.toBeNull();
    expect(Array.from(capped as string)).toHaveLength(2000);
    expect(hasUnstorableChars(capped as string)).toBe(false); // no lone surrogate at the cut
    expect(normalizeDatasetNote("😀".repeat(2000))).toBe("😀".repeat(2000)); // exactly 2000 is untouched
  });
});
