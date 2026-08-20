// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

import * as dbClient from "@/lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";

// Imported after the mocks above so the mocked @/lib/db/client is in effect.
import { createLead, listLeadsForAdmin, updateLeadStatus } from "@/lib/leads";

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
});

afterAll(async () => {
  await tdb.client.close();
});

describe("createLead", () => {
  it("inserts a valid lead and returns an id", async () => {
    const result = await createLead(
      { url: "https://example.com/tip", note: "possible new site" },
      "hash-1"
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toBeTruthy();

    const rows = await listLeadsForAdmin();
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe("https://example.com/tip");
    expect(rows[0].status).toBe("new");
  });

  // Security-relevant: a javascript: URL must be rejected, not stored.
  it("rejects a javascript: URL", async () => {
    const result = await createLead({ url: "javascript:alert(1)" }, "hash-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);

    const rows = await listLeadsForAdmin();
    expect(rows).toHaveLength(0);
  });

  it("rejects a URL over 2000 characters", async () => {
    const longUrl = "https://example.com/" + "a".repeat(2000);
    const result = await createLead({ url: longUrl }, "hash-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it("rejects a note over 500 characters", async () => {
    const longNote = "a".repeat(501);
    const result = await createLead({ url: "https://example.com/tip", note: longNote }, "hash-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);

    const rows = await listLeadsForAdmin();
    expect(rows).toHaveLength(0);
  });

  it("rejects a missing url", async () => {
    const result = await createLead({ note: "no url here" }, "hash-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it("drops an email-like attribution rather than storing it", async () => {
    const result = await createLead(
      { url: "https://example.com/tip", attribution: "someone@example.com" },
      "hash-1"
    );
    expect(result.ok).toBe(true);

    const rows = await listLeadsForAdmin();
    expect(rows[0].attribution).toBeNull();
  });
});

describe("listLeadsForAdmin", () => {
  it("ignores an unrecognized status filter instead of returning nothing", async () => {
    await createLead({ url: "https://example.com/a" }, "hash-1");
    await createLead({ url: "https://example.com/b" }, "hash-1");

    const rows = await listLeadsForAdmin("not-a-real-status");
    expect(rows).toHaveLength(2);
  });

  // Security-relevant: app/admin/leads/page.tsx passes these rows straight
  // into a "use client" component, and EVERY field on a row crosses into the
  // browser in the RSC payload whether or not it's rendered in JSX. This
  // asserts the exact key set rather than merely "no submitterIpHash" so it
  // also fails if any OTHER un-vetted column (present or future) starts
  // crossing the boundary — the actual invariant is "only these columns
  // leave the server," not "this one specific field stays behind."
  it("returns only the columns the admin UI needs, never submitterIpHash", async () => {
    await createLead({ url: "https://example.com/a", note: "n", attribution: "A" }, "hash-1");

    const rows = await listLeadsForAdmin();
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        "id",
        "createdAt",
        "url",
        "note",
        "attribution",
        "status",
        "triage",
        "reviewNote",
        "reviewedAt",
        "promotedSubmissionId",
      ].sort()
    );
    expect(rows[0]).not.toHaveProperty("submitterIpHash");
  });
});

describe("updateLeadStatus", () => {
  it("rejects an unknown status", async () => {
    const created = await createLead({ url: "https://example.com/a" }, "hash-1");
    if (!created.ok) throw new Error("setup failed");

    const result = await updateLeadStatus(created.id, "bogus-status");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it("409s on a repeat transition to the same status", async () => {
    const created = await createLead({ url: "https://example.com/a" }, "hash-1");
    if (!created.ok) throw new Error("setup failed");

    const first = await updateLeadStatus(created.id, "researching");
    expect(first.ok).toBe(true);

    const repeat = await updateLeadStatus(created.id, "researching");
    expect(repeat.ok).toBe(false);
    if (repeat.ok) return;
    expect(repeat.status).toBe(409);
  });
});
