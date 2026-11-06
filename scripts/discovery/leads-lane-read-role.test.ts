/**
 * leads-lane's duplicate check must read `facilities` through the shared
 * read-role client (load-facilities.ts), never the owner getDb().
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const where = vi.fn(async () => [{ id: "a" }, { id: "b" }]);
const db = { select: () => ({ from: () => ({ where }) }) };
const getFacilitiesReadDb = vi.fn();

vi.mock("./load-facilities", () => ({
  getFacilitiesReadDb: (...args: unknown[]) => getFacilitiesReadDb(...args),
}));

import { buildRealDeps } from "./leads-lane";

afterEach(() => vi.clearAllMocks());

describe("leads-lane findPossibleDuplicatesImpl read role", () => {
  it("queries through the reader client from load-facilities", async () => {
    getFacilitiesReadDb.mockReturnValue({ db, role: "reader" });

    const ids = await buildRealDeps().findPossibleDuplicatesImpl({ name: "X", operator: " Acme ", state: "mi", city: null });

    expect(getFacilitiesReadDb).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
    expect(ids).toEqual(["a", "b"]);
  });

  it("throws when neither URL is set", async () => {
    getFacilitiesReadDb.mockReturnValue(null);

    await expect(
      buildRealDeps().findPossibleDuplicatesImpl({ name: "X", operator: "Acme", state: "MI", city: null })
    ).rejects.toThrow("DISCOVERY_READ_DATABASE_URL");
  });
});
