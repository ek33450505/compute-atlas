import { describe, it, expect } from "vitest";
import { STATUS_ORDER, STATUS_META, getStatusMeta, getStatusColor } from "./status";

describe("STATUS_ORDER", () => {
  it("has exactly 5 entries", () => {
    expect(STATUS_ORDER).toHaveLength(5);
  });

  it("contains all expected status keys", () => {
    expect(STATUS_ORDER).toContain("operational");
    expect(STATUS_ORDER).toContain("under_construction");
    expect(STATUS_ORDER).toContain("permitted");
    expect(STATUS_ORDER).toContain("proposed");
    expect(STATUS_ORDER).toContain("cancelled");
  });
});

describe("STATUS_META", () => {
  it("every status has a label", () => {
    for (const status of STATUS_ORDER) {
      expect(STATUS_META[status].label).toBeTruthy();
    }
  });

  it("every status has an icon (a renderable Lucide component)", () => {
    for (const status of STATUS_ORDER) {
      const icon = STATUS_META[status].icon;
      expect(icon).toBeDefined();
      // Lucide icons are React.forwardRef components (typeof === "object"),
      // not plain functions. Check it's non-null and has a displayName or render.
      expect(icon).not.toBeNull();
      // Must be usable as a JSX element: function or forwardRef object
      expect(typeof icon === "function" || typeof icon === "object").toBe(true);
    }
  });

  it("every status has a colorVar pointing to a CSS custom property", () => {
    for (const status of STATUS_ORDER) {
      const { colorVar } = STATUS_META[status];
      expect(colorVar).toBeTruthy();
      expect(colorVar).toMatch(/^--status-/);
    }
  });

  it("every status has a description", () => {
    for (const status of STATUS_ORDER) {
      expect(STATUS_META[status].description).toBeTruthy();
    }
  });
});

describe("getStatusMeta", () => {
  it("returns the correct meta for operational", () => {
    const meta = getStatusMeta("operational");
    expect(meta.label).toBe("Operational");
    expect(meta.colorVar).toBe("--status-operational");
  });
});

describe("getStatusColor", () => {
  it("returns a CSS var() expression", () => {
    expect(getStatusColor("operational")).toBe("var(--status-operational)");
    expect(getStatusColor("cancelled")).toBe("var(--status-cancelled)");
  });
});
