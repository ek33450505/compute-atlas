import { describe, it, expect } from "vitest";

import { STATUS_ORDER } from "@/lib/status";
import { STATUS_CAPACITY_LABEL, capacityTierForStatus, sumCapacityMw } from "./capacity-sums";

describe("sumCapacityMw", () => {
  it("sums the requested tier and treats a missing figure as 0", () => {
    const facilities = [
      { capacityMw: { operational: 100, planned: 50 } },
      { capacityMw: { planned: 25 } },
      { capacityMw: undefined },
    ];
    expect(sumCapacityMw(facilities, "operational")).toBe(100);
    expect(sumCapacityMw(facilities, "planned")).toBe(75);
  });

  it("returns 0 for an empty list", () => {
    expect(sumCapacityMw([], "operational")).toBe(0);
    expect(sumCapacityMw([], "planned")).toBe(0);
  });
});

describe("capacityTierForStatus", () => {
  it("headlines operational capacity only for the operational status", () => {
    expect(capacityTierForStatus("operational")).toBe("operational");
  });

  it.each(["under_construction", "permitted", "proposed", "cancelled"] as const)(
    "headlines planned capacity for %s",
    (status) => {
      expect(capacityTierForStatus(status)).toBe("planned");
    }
  );
});

describe("STATUS_CAPACITY_LABEL", () => {
  it("has a label for every status", () => {
    for (const status of STATUS_ORDER) {
      expect(STATUS_CAPACITY_LABEL[status]).toBeTruthy();
    }
  });

  it("labels the operational tier as operational and the pre-operational tier as planned", () => {
    expect(STATUS_CAPACITY_LABEL.operational).toBe("Operational capacity");
    expect(STATUS_CAPACITY_LABEL.under_construction).toBe("Planned capacity");
    expect(STATUS_CAPACITY_LABEL.permitted).toBe("Planned capacity");
    expect(STATUS_CAPACITY_LABEL.proposed).toBe("Planned capacity");
  });

  it("qualifies only the cancelled label", () => {
    expect(STATUS_CAPACITY_LABEL.cancelled).toBe("Planned capacity (cancelled)");
    for (const status of STATUS_ORDER.filter((s) => s !== "cancelled")) {
      expect(STATUS_CAPACITY_LABEL[status]).not.toContain("(cancelled)");
    }
  });
});
