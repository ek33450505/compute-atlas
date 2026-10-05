// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client");

// Only the outbound send is mocked — the layer notifySubscribersOfChange
// ultimately calls. Its recipient SELECT runs for real against PGlite.
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendChangeNotification: vi.fn().mockResolvedValue({ sent: true }) };
});

import * as dbClient from "@/lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { subscriptionsTable } from "@/lib/db/schema";
import { generateToken, sendChangeNotification } from "@/lib/email";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

// Imported after the mocks above so the mocked modules are in effect.
import { notifySubscribersOfChange, notifySubscribersOfChanges } from "@/lib/notify";
import { confirmedWatcherCounts } from "@/lib/submissions";

/**
 * `confirmedWatcherCounts` (what the approve gate and the CLI/admin warnings
 * show) restates the recipient predicate that `notifySubscribersOfChange` uses
 * to pick who to email — and `notifySubscribersOfChanges`, the batched sibling
 * `sync-to-neon` publishes through, restates it a third time. Nothing but this
 * file fails when they drift, so the number a reviewer is shown could silently
 * stop being the number of people mailed. This asserts all three agree, against
 * each real recipient query.
 */
const facility = facilitiesRaw[0] as unknown as Facility; // xai-colossus-memphis-tn, TN
const otherFacilityId = "some-other-facility";

let tdb: TestDbHandle;

beforeAll(async () => {
  tdb = await makeTestDb();
  vi.mocked(dbClient.getDb).mockReturnValue(tdb.db as never);
  vi.mocked(dbClient.hasDatabaseUrl).mockReturnValue(true);
});

beforeEach(async () => {
  await tdb.reset();
  vi.mocked(sendChangeNotification).mockClear();
});

afterAll(async () => {
  await tdb.client.close();
});

async function insertSubscription(values: {
  targetType: "facility" | "state";
  targetId: string;
  status: "pending" | "confirmed" | "unsubscribed";
}): Promise<void> {
  await tdb.db.insert(subscriptionsTable).values({
    email: `${generateToken().slice(0, 12)}@example.com`,
    targetType: values.targetType,
    targetId: values.targetId,
    status: values.status,
    confirmToken: generateToken(),
    unsubscribeToken: generateToken(),
  });
}

/** Distinct addresses `sendChangeNotification` was called with — only ever compared by size. */
function distinctRecipients(): number {
  const emails = vi.mocked(sendChangeNotification).mock.calls.map(([input]) => input.email);
  return new Set(emails).size;
}

const notifiers: Array<[string, (f: Facility) => Promise<void>]> = [
  ["notifySubscribersOfChange", (f) => notifySubscribersOfChange(f, "x")],
  ["notifySubscribersOfChanges", (f) => notifySubscribersOfChanges([{ facility: f, changeLabel: "x" }])],
];

describe.each(notifiers)("confirmedWatcherCounts agrees with %s's recipients", (_name, notify) => {
  it("counts exactly the confirmed facility-type watchers that get emailed, out of a mix of every other row", async () => {
    // The three that must be mailed.
    for (let i = 0; i < 3; i++) {
      await insertSubscription({ targetType: "facility", targetId: facility.id, status: "confirmed" });
    }
    // Same facility, wrong status.
    for (let i = 0; i < 2; i++) {
      await insertSubscription({ targetType: "facility", targetId: facility.id, status: "pending" });
      await insertSubscription({ targetType: "facility", targetId: facility.id, status: "unsubscribed" });
    }
    // Confirmed, but wrong target type — one even carries this facility's id.
    await insertSubscription({ targetType: "state", targetId: facility.id, status: "confirmed" });
    await insertSubscription({ targetType: "state", targetId: facility.id, status: "confirmed" });
    await insertSubscription({ targetType: "state", targetId: facility.location.state, status: "confirmed" });
    // Confirmed facility watcher of a different facility.
    await insertSubscription({ targetType: "facility", targetId: otherFacilityId, status: "confirmed" });

    const counted = (await confirmedWatcherCounts([facility.id]))[facility.id];
    await notify(facility);

    expect(distinctRecipients()).toBe(counted);
    // Parity alone would still pass if both sides drifted the same way; the
    // literal pins what "a confirmed facility watcher" means.
    expect(counted).toBe(3);
  });

  it("agrees on zero when the facility has only unconfirmed, unsubscribed or wrong-type rows", async () => {
    await insertSubscription({ targetType: "facility", targetId: facility.id, status: "pending" });
    await insertSubscription({ targetType: "facility", targetId: facility.id, status: "unsubscribed" });
    await insertSubscription({ targetType: "state", targetId: facility.id, status: "confirmed" });

    const counted = (await confirmedWatcherCounts([facility.id]))[facility.id] ?? 0;
    await notify(facility);

    expect(distinctRecipients()).toBe(counted);
    expect(counted).toBe(0);
  });
});
