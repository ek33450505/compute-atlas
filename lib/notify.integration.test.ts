// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db/client");
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return {
    ...actual,
    sendChangeNotification: vi.fn().mockResolvedValue({ sent: true }),
  };
});

import * as dbClient from "@/lib/db/client";
import { makeTestDb, type TestDbHandle } from "@/test/pglite-db";
import { subscriptionsTable } from "@/lib/db/schema";
import { generateToken, sendChangeNotification } from "@/lib/email";
import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";

// Imported after the mocks above so their transitive imports (lib/db/client,
// lib/email) resolve against the mocked modules.
import { notifySubscribersOfChange } from "@/lib/notify";

const facilitiesTyped = facilitiesRaw as unknown as Facility[];
const facility = facilitiesTyped[0]; // xai-colossus-memphis-tn, TN, operational
const otherStateFacility = facilitiesTyped.find((f) => f.location.state !== facility.location.state)!; // stargate-abilene-tx, TX

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

type SubscriptionOverrides = {
  email?: string;
  targetType: "facility" | "state" | "all";
  targetId?: string | null;
  status?: "pending" | "confirmed" | "unsubscribed";
};

/** Inserts a subscription row directly (bypassing subscribeToTarget) with sensible defaults. */
async function insertSubscription(
  overrides: SubscriptionOverrides
): Promise<{ email: string; unsubscribeToken: string }> {
  const email = overrides.email ?? "reader@example.com";
  const unsubscribeToken = generateToken();
  await tdb.db.insert(subscriptionsTable).values({
    email,
    targetType: overrides.targetType,
    targetId: overrides.targetId ?? null,
    status: overrides.status ?? "confirmed",
    confirmToken: generateToken(),
    unsubscribeToken,
  });
  return { email, unsubscribeToken };
}

describe("notifySubscribersOfChange", () => {
  it("notifies a confirmed facility-target subscriber for the matching facility", async () => {
    const sub = await insertSubscription({
      targetType: "facility",
      targetId: facility.id,
      status: "confirmed",
    });

    await notifySubscribersOfChange(facility, "record updated");

    expect(sendChangeNotification).toHaveBeenCalledTimes(1);
    expect(sendChangeNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        email: sub.email,
        facilityName: facility.name,
        facilitySlug: facility.id,
        changeLabel: "record updated",
        status: "Operational",
        unsubscribeToken: sub.unsubscribeToken,
      })
    );
  });

  it("does NOT notify a pending (unconfirmed) facility-target subscriber", async () => {
    await insertSubscription({ targetType: "facility", targetId: facility.id, status: "pending" });

    await notifySubscribersOfChange(facility, "record updated");

    expect(sendChangeNotification).not.toHaveBeenCalled();
  });

  it("does NOT notify an unsubscribed facility-target subscriber", async () => {
    await insertSubscription({ targetType: "facility", targetId: facility.id, status: "unsubscribed" });

    await notifySubscribersOfChange(facility, "record updated");

    expect(sendChangeNotification).not.toHaveBeenCalled();
  });

  it("does NOT notify a confirmed facility-sub targeting a different facility id", async () => {
    await insertSubscription({
      targetType: "facility",
      targetId: otherStateFacility.id,
      status: "confirmed",
    });

    await notifySubscribersOfChange(facility, "record updated");

    expect(sendChangeNotification).not.toHaveBeenCalled();
  });

  it("notifies a confirmed state subscriber when facility.location.state matches", async () => {
    const sub = await insertSubscription({
      targetType: "state",
      targetId: facility.location.state,
      status: "confirmed",
    });

    await notifySubscribersOfChange(facility, "record updated");

    expect(sendChangeNotification).toHaveBeenCalledTimes(1);
    expect(sendChangeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ email: sub.email, unsubscribeToken: sub.unsubscribeToken })
    );
  });

  it("does NOT notify a confirmed state subscriber for a different state", async () => {
    await insertSubscription({
      targetType: "state",
      targetId: otherStateFacility.location.state,
      status: "confirmed",
    });

    await notifySubscribersOfChange(facility, "record updated");

    expect(sendChangeNotification).not.toHaveBeenCalled();
  });

  it("notifies a confirmed 'all' subscriber for any facility", async () => {
    const sub = await insertSubscription({ targetType: "all", status: "confirmed" });

    await notifySubscribersOfChange(otherStateFacility, "status updated");

    expect(sendChangeNotification).toHaveBeenCalledTimes(1);
    expect(sendChangeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ email: sub.email, unsubscribeToken: sub.unsubscribeToken })
    );
  });

  it("passes each subscriber's own unsubscribeToken, not a shared one", async () => {
    const subA = await insertSubscription({ email: "a@example.com", targetType: "all", status: "confirmed" });
    const subB = await insertSubscription({ email: "b@example.com", targetType: "all", status: "confirmed" });

    await notifySubscribersOfChange(facility, "record updated");

    expect(sendChangeNotification).toHaveBeenCalledTimes(2);
    expect(sendChangeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ email: subA.email, unsubscribeToken: subA.unsubscribeToken })
    );
    expect(sendChangeNotification).toHaveBeenCalledWith(
      expect.objectContaining({ email: subB.email, unsubscribeToken: subB.unsubscribeToken })
    );
    expect(subA.unsubscribeToken).not.toBe(subB.unsubscribeToken);
  });

  it("sends zero notifications and does not throw when there are no confirmed subscribers", async () => {
    await insertSubscription({ targetType: "facility", targetId: facility.id, status: "pending" });
    await insertSubscription({
      targetType: "state",
      targetId: facility.location.state,
      status: "unsubscribed",
    });

    await expect(notifySubscribersOfChange(facility, "record updated")).resolves.toBeUndefined();
    expect(sendChangeNotification).not.toHaveBeenCalled();
  });
});
