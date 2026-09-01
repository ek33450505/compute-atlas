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
import { contactMessagesTable } from "@/lib/db/schema";

// Imported after the mocks above so the mocked @/lib/db/client is in effect.
import { createContactMessage, setContactEmailSent } from "@/lib/contact";

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

const VALID = {
  name: "Jamie Rivera",
  email: "Jamie@Example.com",
  topic: "press" as const,
  message: "This is a message with well over twenty characters in it.",
};

describe("createContactMessage", () => {
  it("inserts a valid message and returns an id", async () => {
    const result = await createContactMessage(VALID, "hash-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.id).toBeTruthy();
    // Email is normalized (trimmed + lowercased) before storage.
    expect(result.email).toBe("jamie@example.com");

    const rows = await tdb.db.select().from(contactMessagesTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Jamie Rivera");
    expect(rows[0].email).toBe("jamie@example.com");
    expect(rows[0].topic).toBe("press");
    expect(rows[0].emailSent).toBe(false);
  });

  it("trims name and message before storage", async () => {
    const result = await createContactMessage(
      { ...VALID, name: "  Jamie Rivera  ", message: `  ${VALID.message}  ` },
      "hash-1"
    );
    expect(result.ok).toBe(true);

    const rows = await tdb.db.select().from(contactMessagesTable);
    expect(rows[0].name).toBe("Jamie Rivera");
    expect(rows[0].message).toBe(VALID.message);
  });

  it.each(["", "a".repeat(121)])("rejects a name of invalid length (%#)", async (name) => {
    const result = await createContactMessage({ ...VALID, name }, "hash-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);

    const rows = await tdb.db.select().from(contactMessagesTable);
    expect(rows).toHaveLength(0);
  });

  it("rejects a malformed email", async () => {
    const result = await createContactMessage({ ...VALID, email: "not-an-email" }, "hash-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it("rejects an email over 200 characters", async () => {
    const longEmail = `${"a".repeat(195)}@x.com`; // > 200 chars total
    const result = await createContactMessage({ ...VALID, email: longEmail }, "hash-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it("rejects a topic outside the fixed enum", async () => {
    const result = await createContactMessage({ ...VALID, topic: "sales" }, "hash-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it("rejects a message under 20 characters", async () => {
    const result = await createContactMessage({ ...VALID, message: "too short" }, "hash-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it("rejects a message over 4000 characters", async () => {
    const result = await createContactMessage({ ...VALID, message: "a".repeat(4001) }, "hash-1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);

    const rows = await tdb.db.select().from(contactMessagesTable);
    expect(rows).toHaveLength(0);
  });
});

describe("setContactEmailSent", () => {
  it("updates emailSent on an existing row", async () => {
    const created = await createContactMessage(VALID, "hash-1");
    if (!created.ok) throw new Error("setup failed");

    const updated = await setContactEmailSent(created.id, true);
    expect(updated?.emailSent).toBe(true);

    const rows = await tdb.db.select().from(contactMessagesTable);
    expect(rows[0].emailSent).toBe(true);
  });
});
