import { describe, it, expect } from "vitest";

import facilitiesRaw from "@/data/facilities.json";
import type { Facility } from "@/lib/schema";
import {
  PINNED_RECORD_SPECIMEN_ID,
  qualifiesAsPinnedSpecimen,
  selectRecordSpecimen,
} from "@/lib/data";

/**
 * The homepage specimen is pinned to one record (see `PINNED_SPECIMEN_ID` in
 * lib/data.ts). `selectRecordSpecimen` falls back to its ranking when that
 * record is missing or no longer qualifies, which keeps the page working — and
 * hides the change completely. This file is the loud half.
 *
 * What a PASSING check looks like while the bug is present: nothing does. If a
 * wave retires the pinned facility, drops it below three citations, or strips
 * its last status event, the homepage silently starts featuring a different
 * site and every assertion here goes red naming which term failed.
 *
 * Asserted against data/facilities.json rather than a fixture on purpose: a
 * fixture would prove the pin mechanism works, which the fallback tests in
 * lib/data.selectRecordSpecimen.test.ts already do. Only the live snapshot can
 * prove the pinned record still EXISTS.
 */
const facilities = facilitiesRaw as unknown as Facility[];

describe("the pinned homepage specimen", () => {
  const pinned = facilities.find((f) => f.id === PINNED_RECORD_SPECIMEN_ID);

  it("is present in the published dataset", () => {
    expect(
      pinned,
      `PINNED_SPECIMEN_ID "${PINNED_RECORD_SPECIMEN_ID}" is not in data/facilities.json. ` +
        `The homepage has silently fallen back to its capacity ranking. Either restore ` +
        `the record or choose a new pin deliberately.`
    ).toBeDefined();
  });

  it("still clears every term of the pin's bar", () => {
    expect(pinned).toBeDefined();
    // Spelled out term by term rather than delegating to
    // qualifiesAsPinnedSpecimen alone, so a failure names the term that broke
    // instead of reporting one opaque false.
    expect(pinned!.sources.length).toBeGreaterThanOrEqual(3);
    expect(pinned!.statusHistory.length).toBeGreaterThanOrEqual(1);
    expect(
      Math.max(
        pinned!.capacityMw?.operational ?? 0,
        pinned!.capacityMw?.planned ?? 0
      )
    ).toBeGreaterThan(0);
    expect(qualifiesAsPinnedSpecimen(pinned!)).toBe(true);
  });

  it("is what the live dataset actually selects", () => {
    // The terms above could all hold while the selector still returned
    // something else — this is the only assertion that closes that gap.
    expect(selectRecordSpecimen(facilities)?.id).toBe(PINNED_RECORD_SPECIMEN_ID);
  });

  it("is the Pike County, Ohio megasite it was pinned for", () => {
    expect(pinned).toBeDefined();
    // The pin is editorial, so its identity is part of the contract: an id
    // that still resolves but now points at a different place is exactly the
    // silent swap this file exists to catch.
    expect(pinned!.location.state).toBe("OH");
    expect(pinned!.location.county).toBe("Pike");
  });
});
