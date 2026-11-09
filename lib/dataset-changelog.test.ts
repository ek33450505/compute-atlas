import { describe, it, expect } from "vitest";
import { buildChangelog, type BuildChangelogInput } from "@/lib/dataset-changelog";
import type { Facility } from "@/lib/schema";

type Row = BuildChangelogInput["history"][number];

const PREV = new Date("2026-11-02T06:00:00.000Z");
const BUILT = new Date("2026-11-09T06:00:00.000Z");
const INSIDE = new Date("2026-11-05T12:00:00.000Z");

function facility(id: string, name: string, state = "OH"): Facility {
  return {
    id,
    name,
    operator: "Test Operator",
    status: "operational",
    facilityType: "data_center",
    aiClassification: "confirmed",
    confidence: "confirmed",
    location: { lat: 40, lon: -83, state, precision: "exact" },
    statusHistory: [],
    sources: [
      { url: "https://example.com/s", label: "S", retrievedAt: "2026-01-01", kind: "press" },
    ],
    lastUpdated: "2026-11",
  } as Facility;
}

function row(
  facilityId: string,
  changeType: Row["changeType"],
  changedAt: Date,
  diff: Row["diff"] = [],
): Row {
  return { facilityId, changeType, changedAt, diff };
}

function build(history: Row[], facilities: Facility[], prev: Date | null = PREV) {
  return buildChangelog({ history, facilities, prevBuiltAt: prev, builtAt: BUILT });
}

function regular(c: ReturnType<typeof build>["changelog"]) {
  if (c.initial) throw new Error("expected a non-initial changelog");
  return c;
}

describe("buildChangelog window", () => {
  it("excludes a row exactly at prevBuiltAt and includes one exactly at builtAt", () => {
    const { changelog, summary } = build(
      [
        row("a", "create", PREV),
        row("b", "create", BUILT),
        row("c", "create", new Date(PREV.getTime() - 1)),
        row("d", "create", new Date(BUILT.getTime() + 1)),
      ],
      [facility("a", "A"), facility("b", "B"), facility("c", "C"), facility("d", "D")],
    );
    expect(regular(changelog).added.map((e) => e.id)).toEqual(["b"]);
    expect(summary.added).toBe(1);
  });

  it("reports the window as ISO timestamps", () => {
    expect(regular(build([], []).changelog).editionWindow).toEqual({
      from: PREV.toISOString(),
      to: BUILT.toISOString(),
    });
  });

  it("returns empty lists and zero counts for an empty window", () => {
    const { changelog, summary } = build([], [facility("a", "A")]);
    expect(regular(changelog)).toMatchObject({ added: [], updated: [], removed: [] });
    expect(summary).toEqual({ added: 0, updated: 0, removed: 0, headlines: [] });
  });
});

describe("buildChangelog classification", () => {
  it("excludes editorial rows", () => {
    const { changelog, summary } = build(
      [row("a", "editorial", INSIDE, [{ key: "notes", before: "x", after: "y" }])],
      [facility("a", "A")],
    );
    expect(regular(changelog).updated).toEqual([]);
    expect(summary.updated).toBe(0);
  });

  it("collapses create + update into a single added entry", () => {
    const { changelog } = build(
      [
        row("a", "create", INSIDE),
        row("a", "update", new Date(INSIDE.getTime() + 1000), [
          { key: "status", before: "proposed", after: "operational" },
        ]),
      ],
      [facility("a", "Alpha", "TX")],
    );
    const c = regular(changelog);
    expect(c.added).toEqual([{ id: "a", name: "Alpha", state: "TX" }]);
    expect(c.updated).toEqual([]);
  });

  it("omits a facility created and deleted inside the window", () => {
    const { changelog, summary } = build(
      [row("a", "create", INSIDE), row("a", "delete", new Date(INSIDE.getTime() + 1000))],
      [],
    );
    const c = regular(changelog);
    expect([c.added, c.updated, c.removed]).toEqual([[], [], []]);
    expect(summary.added + summary.updated + summary.removed).toBe(0);
  });

  it.each([
    ["update listed before delete", ["update", "delete"]],
    ["delete listed before update", ["delete", "update"]],
  ] as const)(
    "reports a delete tied with an update at the same instant as removed (%s)",
    (_label, order) => {
      const rows = order.map((type) =>
        type === "delete"
          ? row("a", "delete", INSIDE, [{ key: "name", before: "Gone", after: null }])
          : row("a", "update", INSIDE, [{ key: "operator", before: "x", after: "y" }]),
      );
      const c = regular(build(rows, []).changelog);
      expect(c.removed.map((e) => e.id)).toEqual(["a"]);
      expect(c.updated).toEqual([]);
    },
  );

  it.each([
    ["create listed before delete", ["create", "delete"]],
    ["delete listed before create", ["delete", "create"]],
  ] as const)(
    "omits a facility created and deleted at the same instant (%s)",
    (_label, order) => {
      const rows = order.map((type) =>
        row("a", type, INSIDE, [{ key: "name", before: null, after: "Blink" }]),
      );
      const { changelog, summary } = build(rows, []);
      const c = regular(changelog);
      expect([c.added, c.updated, c.removed]).toEqual([[], [], []]);
      expect(summary.added + summary.updated + summary.removed).toBe(0);
    },
  );

  it("unions and sorts changed field keys across several updates", () => {
    const { changelog } = build(
      [
        row("a", "update", INSIDE, [
          { key: "operator", before: "x", after: "y" },
          { key: "capacityMw", before: 1, after: 2 },
        ]),
        row("a", "update", new Date(INSIDE.getTime() + 1000), [
          { key: "capacityMw", before: 2, after: 3 },
          { key: "status", before: "proposed", after: "operational" },
        ]),
      ],
      [facility("a", "Alpha")],
    );
    expect(regular(changelog).updated).toEqual([
      { id: "a", name: "Alpha", state: "OH", fields: ["capacityMw", "operator", "status"] },
    ]);
  });

  it("omits an update whose diff changed no field", () => {
    const { changelog } = build([row("a", "update", INSIDE, [])], [facility("a", "A")]);
    expect(regular(changelog).updated).toEqual([]);
  });

  it("takes a removed facility's name and state from the delete diff", () => {
    const { changelog } = build(
      [
        row("gone", "delete", INSIDE, [
          { key: "name", before: "Gone Site", after: null },
          { key: "location", before: { lat: 1, lon: 2, state: "VA" }, after: null },
          { key: "operator", before: "Secret Op", after: null },
        ]),
      ],
      [],
    );
    expect(regular(changelog).removed).toEqual([{ id: "gone", name: "Gone Site", state: "VA" }]);
    expect(JSON.stringify(changelog)).not.toContain("Secret Op");
  });

  it("falls back to the id alone for a removed facility with no usable diff", () => {
    const { changelog } = build([row("gone", "delete", INSIDE, [])], []);
    expect(regular(changelog).removed).toEqual([{ id: "gone" }]);
  });

  it("never carries diff values other than names", () => {
    const { changelog, summary } = build(
      [
        row("a", "update", INSIDE, [
          { key: "operator", before: "OLD-OPERATOR-VALUE", after: "NEW-OPERATOR-VALUE" },
        ]),
      ],
      [facility("a", "Alpha")],
    );
    const out = JSON.stringify({ changelog, summary });
    expect(out).not.toContain("OLD-OPERATOR-VALUE");
    expect(out).not.toContain("NEW-OPERATOR-VALUE");
  });
});

describe("buildChangelog summary headlines", () => {
  it("writes a status headline from the first before to the last after", () => {
    const { summary } = build(
      [
        row("a", "update", INSIDE, [{ key: "status", before: "proposed", after: "permitted" }]),
        row("a", "update", new Date(INSIDE.getTime() + 1000), [
          { key: "status", before: "permitted", after: "operational" },
        ]),
      ],
      [facility("a", "Alpha")],
    );
    expect(summary.headlines).toEqual(["Alpha: proposed → operational"]);
  });

  it("orders added, then removals, then status changes, then other updates", () => {
    const { summary } = build(
      [
        row("u", "update", INSIDE, [{ key: "operator", before: "x", after: "y" }]),
        row("s", "update", INSIDE, [{ key: "status", before: "proposed", after: "operational" }]),
        row("n", "create", INSIDE),
        row("r", "delete", INSIDE, [{ key: "name", before: "Removed Site", after: null }]),
      ],
      [facility("u", "Updated Site"), facility("s", "Status Site"), facility("n", "New Site")],
    );
    expect(summary.headlines).toEqual([
      "Added: New Site",
      "Removed: Removed Site",
      "Status Site: proposed → operational",
      "Updated: Updated Site (operator)",
    ]);
    expect(summary).toMatchObject({ added: 1, updated: 2, removed: 1 });
  });

  it("caps headlines at 10 and orders ties by name then id", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, "0")}`);
    const facilities = ids.map((id) => facility(id, "Same Name"));
    const history = [...ids].reverse().map((id) => row(id, "create", INSIDE));
    const { summary, changelog } = build(history, facilities);
    expect(summary.added).toBe(12);
    expect(summary.headlines).toHaveLength(10);
    expect(regular(changelog).added.map((e) => e.id)).toEqual(ids);
  });

  it("keeps a removal in the headlines when 12 changes exceed the cap", () => {
    const ids = Array.from({ length: 11 }, (_, i) => `n${String(i).padStart(2, "0")}`);
    const history = [
      ...ids.map((id) => row(id, "update", INSIDE, [{ key: "operator", before: "x", after: "y" }])),
      row("gone", "delete", INSIDE, [{ key: "name", before: "Gone Site", after: null }]),
    ];
    const { summary } = build(
      history,
      ids.map((id) => facility(id, `New ${id}`)),
    );
    expect(summary.headlines).toHaveLength(10);
    expect(summary.headlines).toContain("Removed: Gone Site");
  });

  it("sorts entries by name", () => {
    const { changelog } = build(
      [row("1", "create", INSIDE), row("2", "create", INSIDE)],
      [facility("1", "Zulu"), facility("2", "Alpha")],
    );
    expect(regular(changelog).added.map((e) => e.name)).toEqual(["Alpha", "Zulu"]);
  });
});

describe("buildChangelog first edition", () => {
  it("emits the initial shape with no history dump", () => {
    const { changelog, summary } = build(
      [row("a", "create", INSIDE)],
      [facility("a", "A"), facility("b", "B"), facility("c", "C")],
      null,
    );
    expect(changelog).toEqual({
      initial: true,
      editionWindow: { from: null, to: BUILT.toISOString() },
      recordCount: 3,
    });
    expect(summary).toEqual({
      added: 0,
      updated: 0,
      removed: 0,
      headlines: ["Initial edition: 3 records"],
    });
  });
});

describe("buildChangelog safety and determinism", () => {
  it("never emits row sources or per-change timestamps", () => {
    // `source` is not part of the accepted row type, but a caller passing full
    // FacilityHistoryRow objects must not leak it either.
    const leaky = {
      ...row("a", "update", INSIDE, [{ key: "status", before: "proposed", after: "operational" }]),
      source: "SUBMISSION-9f3c-DISTINCT",
      id: "ROW-UUID-DISTINCT",
    };
    const { changelog, summary } = build([leaky], [facility("a", "Alpha")]);
    const out = JSON.stringify({ changelog, summary });
    expect(out).not.toContain("SUBMISSION-9f3c-DISTINCT");
    expect(out).not.toContain("ROW-UUID-DISTINCT");
    expect(out).not.toContain(INSIDE.toISOString());
  });

  it("is byte-identical for the same input regardless of row order", () => {
    const history = [
      row("a", "create", INSIDE),
      row("b", "update", INSIDE, [{ key: "status", before: "x", after: "y" }]),
      row("c", "delete", INSIDE, [{ key: "name", before: "C", after: null }]),
    ];
    const facilities = [facility("a", "A"), facility("b", "B")];
    const one = build(history, facilities);
    const two = build([...history].reverse(), [...facilities].reverse());
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });
});
