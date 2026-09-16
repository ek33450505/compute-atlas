import { describe, it, expect } from "vitest";

import { STATUS_ORDER as STATUS_ORDER_FROM_LIB } from "@/lib/status";
import {
  assertHasQuarters,
  assertReconciled,
  assertUsableAsOf,
  buildPipelineHistoryData,
  peakAmbiguous,
  quarterEnd,
  quarterOf,
  quarterRange,
  resolveEventDate,
  STATUS_ORDER,
  START_QUARTER,
} from "./build-pipeline-history.mjs";

/** The subset of a facility this generator reads. */
interface HistoryFacility {
  id: string;
  status: string;
  statusHistory?: Array<{ status: string; date: string }>;
}

interface Quarter {
  quarter: string;
  end: string;
  known: number;
  ambiguous: number;
  /** `ambiguous`'s two disjoint causes; they sum to it. */
  ambiguousEntry: number;
  ambiguousStatus: number;
  counts: Record<string, number>;
  partial?: boolean;
}

interface Artifact {
  asOf: string | null;
  statuses: string[];
  coverage: {
    totalFacilities: number;
    withHistory: number;
    excludedNoHistory: number;
    earliestEvent: string | null;
    latestEvent: string | null;
    quartersOmitted: number;
    knownAtStart: number;
    datePrecision: { year: number; month: number; day: number };
    unparseableDates: number;
    ambiguousPeak: {
      quarter: string;
      count: number;
      entry: number;
      status: number;
      known: number;
      share: number;
    } | null;
  };
  quarters: Quarter[];
}

/**
 * Fixtures, never the live dataset: a test asserting against
 * data/facilities.json breaks on every data wave.
 */
function facility(over: Partial<HistoryFacility> = {}): HistoryFacility {
  return {
    id: over.id ?? "test-facility",
    status: over.status ?? "operational",
    ...(over.statusHistory === undefined ? {} : { statusHistory: over.statusHistory }),
  };
}

/**
 * The axis is clamped forward to the first quarter in which anything is known
 * (see "window and coverage metadata" below), so a fixture whose only facility
 * arrives late has no leading quarters to assert absence in. This anchor
 * occupies 2024Q1 onward so those assertions run against a real, non-empty
 * denominator — which is also the realistic case.
 */
function anchor(): HistoryFacility {
  return facility({
    id: "anchor",
    status: "operational",
    statusHistory: [{ status: "operational", date: "2024-01-01" }],
  });
}

/** A fixed window so quarter labels in assertions are literals, not derived. */
const OPTIONS = {
  asOf: "2024-12-31T00:00:00.000Z",
  startQuarter: { year: 2024, quarter: 1 },
} as const;

function build(facilities: HistoryFacility[], options = OPTIONS): Artifact {
  return buildPipelineHistoryData(facilities, options) as Artifact;
}

function quarter(artifact: Artifact, label: string): Quarter {
  const row = artifact.quarters.find((q) => q.quarter === label);
  if (!row) throw new Error(`no quarter ${label} in [${artifact.quarters.map((q) => q.quarter)}]`);
  return row;
}

describe("STATUS_ORDER — duplicated from lib/status.ts", () => {
  it("matches lib/status.ts exactly, including ORDER", () => {
    // Order is the chart's stacking order, and a Record's key order is not
    // part of its type — nothing but this assertion catches a reorder.
    expect(STATUS_ORDER).toEqual([...STATUS_ORDER_FROM_LIB]);
  });
});

describe("resolveEventDate — partial dates resolve to the START of their period", () => {
  it("expands a bare year to 1 January, and names 31 December as its period end", () => {
    expect(resolveEventDate("2025")).toEqual({
      day: "2025-01-01",
      periodEnd: "2025-12-31",
      precision: "year",
    });
  });

  it("expands a year-month to the 1st, and names that month's last day as its end", () => {
    expect(resolveEventDate("2025-06")).toEqual({
      day: "2025-06-01",
      periodEnd: "2025-06-30",
      precision: "month",
    });
  });

  it("ends a 31-day month on the 31st, not on a hardcoded 30", () => {
    expect(resolveEventDate("2025-07")?.periodEnd).toBe("2025-07-31");
  });

  it("ends February on the 29th in a leap year and the 28th otherwise", () => {
    expect(resolveEventDate("2024-02")?.periodEnd).toBe("2024-02-29");
    expect(resolveEventDate("2025-02")?.periodEnd).toBe("2025-02-28");
  });

  it("passes a full date through unchanged, with start and end equal", () => {
    expect(resolveEventDate("2025-06-17")).toEqual({
      day: "2025-06-17",
      periodEnd: "2025-06-17",
      precision: "day",
    });
  });

  it("returns null for a string naming no year", () => {
    expect(resolveEventDate("sometime")).toBeNull();
    expect(resolveEventDate(undefined)).toBeNull();
  });
});

/**
 * Three classes that a prefix-matching, range-free pattern accepted SILENTLY,
 * each producing a plausible-looking wrong value rather than an error. None
 * occur in today's data, which is exactly why they need tests: the next bad
 * import is the one that finds them.
 */
describe("resolveEventDate — malformed dates are rejected, never coerced", () => {
  it("rejects a one-digit month instead of reading it as a bare year", () => {
    // Prefix-matching consumed "2025" and dropped "-9", filing a September
    // event as 2025-01-01 at YEAR precision — eight months early.
    expect(resolveEventDate("2025-9")).toBeNull();
  });

  it("rejects a compact YYYYMMDD instead of reading its first four digits", () => {
    // Same failure: "20250915" matched the leading "2025" and became
    // 2025-01-01, indistinguishable downstream from a real year-only date.
    expect(resolveEventDate("20250915")).toBeNull();
  });

  it("rejects month 13 rather than letting it become a quarter 5", () => {
    // quarterOf(month 13) => Math.floor(12 / 3) + 1 = 5, which emitted a
    // "2026Q5" row ending 2027-03-31 — a nonsense quarter on the axis.
    expect(resolveEventDate("2024-13-01")).toBeNull();
  });

  it("rejects month 0", () => {
    expect(resolveEventDate("2024-00-01")).toBeNull();
    expect(resolveEventDate("2024-00")).toBeNull();
  });

  it("rejects a day that does not exist in its month", () => {
    expect(resolveEventDate("2025-02-31")).toBeNull();
    expect(resolveEventDate("2025-04-31")).toBeNull();
    expect(resolveEventDate("2025-01-00")).toBeNull();
  });

  it("accepts 29 February in a leap year and rejects it otherwise", () => {
    expect(resolveEventDate("2024-02-29")?.day).toBe("2024-02-29");
    expect(resolveEventDate("2025-02-29")).toBeNull();
  });

  it("rejects trailing junk after an otherwise valid date", () => {
    expect(resolveEventDate("2025-06-17T00:00:00Z")).toBeNull();
    expect(resolveEventDate("2025-06-17x")).toBeNull();
  });

  it("counts each rejected class in unparseableDates rather than placing it", () => {
    const artifact = build([
      anchor(),
      facility({
        id: "malformed",
        status: "operational",
        statusHistory: [
          { status: "proposed", date: "2025-9" },
          { status: "proposed", date: "20250915" },
          { status: "permitted", date: "2024-13-01" },
          { status: "permitted", date: "2025-02-31" },
          { status: "operational", date: "2024-05-01" },
        ],
      }),
    ]);

    expect(artifact.coverage.unparseableDates).toBe(4);
    // Only the one well-formed event placed it, so it is absent in 2024Q1 and
    // operational from 2024Q2 — never carrying a coerced 2025-01-01 or a
    // quarter-5 row.
    expect(quarter(artifact, "2024Q1").known).toBe(1);
    expect(quarter(artifact, "2024Q2").counts.operational).toBe(2);
    expect(artifact.quarters.map((q) => q.quarter)).toEqual([
      "2024Q1",
      "2024Q2",
      "2024Q3",
      "2024Q4",
    ]);
  });
});

describe("quarter arithmetic", () => {
  it("ends each quarter on its real last day, including a leap February", () => {
    expect(quarterEnd(2024, 1)).toBe("2024-03-31");
    expect(quarterEnd(2024, 2)).toBe("2024-06-30");
    expect(quarterEnd(2024, 3)).toBe("2024-09-30");
    expect(quarterEnd(2024, 4)).toBe("2024-12-31");
  });

  it("maps a day to its quarter", () => {
    expect(quarterOf("2024-01-01")).toEqual({ year: 2024, quarter: 1 });
    expect(quarterOf("2024-03-31")).toEqual({ year: 2024, quarter: 1 });
    expect(quarterOf("2024-04-01")).toEqual({ year: 2024, quarter: 2 });
    expect(quarterOf("2024-12-31")).toEqual({ year: 2024, quarter: 4 });
  });

  it("enumerates inclusively across a year boundary", () => {
    expect(quarterRange({ year: 2023, quarter: 3 }, { year: 2024, quarter: 2 })).toEqual([
      { year: 2023, quarter: 3 },
      { year: 2023, quarter: 4 },
      { year: 2024, quarter: 1 },
      { year: 2024, quarter: 2 },
    ]);
  });
});

describe("state reconstruction", () => {
  it("places a facility with two events in the right status in each quarter", () => {
    const artifact = build([
      facility({
        id: "two-events",
        status: "operational",
        statusHistory: [
          { status: "proposed", date: "2024-01-15" },
          { status: "under_construction", date: "2024-07-10" },
        ],
      }),
    ]);

    expect(quarter(artifact, "2024Q1").counts.proposed).toBe(1);
    expect(quarter(artifact, "2024Q1").counts.under_construction).toBe(0);
    expect(quarter(artifact, "2024Q3").counts.under_construction).toBe(1);
    expect(quarter(artifact, "2024Q3").counts.proposed).toBe(0);
  });

  it("is ABSENT before its first event — not counted as anything (rule 3)", () => {
    const artifact = build([
      anchor(),
      facility({
        id: "late-arrival",
        status: "operational",
        statusHistory: [{ status: "proposed", date: "2024-07-10" }],
      }),
    ]);

    // Only the anchor is known before 2024Q3 — the late arrival is in no
    // bucket at all, not even the one it later occupies.
    expect(quarter(artifact, "2024Q1").known).toBe(1);
    expect(quarter(artifact, "2024Q2").known).toBe(1);
    expect(quarter(artifact, "2024Q1").counts.proposed).toBe(0);
    expect(quarter(artifact, "2024Q2").counts.proposed).toBe(0);
    expect(quarter(artifact, "2024Q3").known).toBe(2);
    expect(quarter(artifact, "2024Q3").counts.proposed).toBe(1);
  });

  it("carries a facility FORWARD past its last event (rule 4)", () => {
    const artifact = build([
      facility({
        id: "quiet-since",
        status: "operational",
        statusHistory: [{ status: "permitted", date: "2024-02-01" }],
      }),
    ]);

    for (const label of ["2024Q1", "2024Q2", "2024Q3", "2024Q4"]) {
      expect(quarter(artifact, label).counts.permitted).toBe(1);
      expect(quarter(artifact, label).known).toBe(1);
    }
  });

  it("keeps a CANCELLED facility occupying the composition (rule 4)", () => {
    // Evicting it would silently re-normalise the mix and read as growth.
    const artifact = build([
      facility({
        id: "dead",
        status: "cancelled",
        statusHistory: [
          { status: "proposed", date: "2024-01-05" },
          { status: "cancelled", date: "2024-05-05" },
        ],
      }),
    ]);

    expect(quarter(artifact, "2024Q4").counts.cancelled).toBe(1);
    expect(quarter(artifact, "2024Q4").known).toBe(1);
  });

  it("uses the LATEST event on or before the quarter end when several precede it", () => {
    const artifact = build([
      facility({
        id: "busy",
        status: "operational",
        statusHistory: [
          { status: "proposed", date: "2024-01-05" },
          { status: "permitted", date: "2024-02-05" },
          { status: "under_construction", date: "2024-03-05" },
        ],
      }),
    ]);

    expect(quarter(artifact, "2024Q1").counts.under_construction).toBe(1);
    expect(quarter(artifact, "2024Q1").known).toBe(1);
  });

  it("orders events by resolved date, not by array order", () => {
    const artifact = build([
      facility({
        id: "out-of-order",
        status: "operational",
        statusHistory: [
          { status: "under_construction", date: "2024-03-05" },
          { status: "proposed", date: "2024-01-05" },
        ],
      }),
    ]);

    expect(quarter(artifact, "2024Q1").counts.under_construction).toBe(1);
    expect(quarter(artifact, "2024Q1").counts.proposed).toBe(0);
  });
});

describe("the fabrication guard — a facility with NO statusHistory", () => {
  // The single most important assertion in this unit. Falling back to
  // `facility.status` would assert that a facility held its CURRENT status in
  // every past quarter, which is exactly the fabrication this artifact exists
  // to avoid.
  const noHistory = [
    facility({ id: "no-field", status: "operational" }),
    facility({ id: "empty-array", status: "under_construction", statusHistory: [] }),
  ];

  it("is excluded from EVERY quarter, in every bucket", () => {
    // The two history-less facilities are `operational` and
    // `under_construction` TODAY; the only facility with history is
    // `permitted`. A fallback to `facility.status` would show up as a nonzero
    // operational/under_construction count in some quarter.
    const artifact = build([
      ...noHistory,
      facility({
        id: "real",
        status: "permitted",
        statusHistory: [{ status: "permitted", date: "2024-01-10" }],
      }),
    ]);

    expect(artifact.quarters.length).toBeGreaterThan(0);
    for (const row of artifact.quarters) {
      expect(row.known, row.quarter).toBe(1);
      expect(row.counts.permitted, row.quarter).toBe(1);
      expect(row.counts.operational, row.quarter).toBe(0);
      expect(row.counts.under_construction, row.quarter).toBe(0);
    }
  });

  it("does not occupy a quarter it predates either — no backfill in any direction", () => {
    const artifact = build([
      ...noHistory,
      anchor(),
      facility({
        id: "real",
        status: "proposed",
        statusHistory: [{ status: "proposed", date: "2024-07-10" }],
      }),
    ]);

    // anchor only in Q1/Q2; anchor + real in Q3/Q4. Never the two excluded.
    expect(quarter(artifact, "2024Q2").known).toBe(1);
    expect(quarter(artifact, "2024Q4").known).toBe(2);
  });

  it("publishes the excluded count so the consumer can disclose it", () => {
    const artifact = build([...noHistory, anchor()]);

    expect(artifact.coverage.excludedNoHistory).toBe(2);
    expect(artifact.coverage.withHistory).toBe(1);
    expect(artifact.coverage.totalFacilities).toBe(3);
  });
});

describe("internal consistency", () => {
  it("known equals the sum of the per-status counts in EVERY quarter", () => {
    const artifact = build([
      facility({
        id: "a",
        status: "operational",
        statusHistory: [
          { status: "proposed", date: "2024-01-01" },
          { status: "operational", date: "2024-08-01" },
        ],
      }),
      facility({
        id: "b",
        status: "cancelled",
        statusHistory: [
          { status: "permitted", date: "2024-02-01" },
          { status: "cancelled", date: "2024-11-01" },
        ],
      }),
      facility({
        id: "c",
        status: "under_construction",
        statusHistory: [{ status: "under_construction", date: "2024-06-15" }],
      }),
      facility({ id: "d", status: "proposed" }),
    ]);

    for (const row of artifact.quarters) {
      const summed = STATUS_ORDER.reduce((sum: number, s: string) => sum + row.counts[s], 0);
      expect(summed, `${row.quarter}`).toBe(row.known);
    }
    // Guard against the invariant holding vacuously over all-zero quarters.
    expect(artifact.quarters.some((q) => q.known > 0)).toBe(true);
    expect(quarter(artifact, "2024Q4").known).toBe(3);
  });

  it("emits every status key in every quarter, even at zero", () => {
    const artifact = build([
      facility({
        id: "only-proposed",
        status: "proposed",
        statusHistory: [{ status: "proposed", date: "2024-01-01" }],
      }),
    ]);

    // A LITERAL, not `[...STATUS_ORDER]`: asserting against the constant the
    // code derives its keys from cannot fail, so it would pass under any
    // permutation or renaming of the very order it exists to pin.
    for (const row of artifact.quarters) {
      expect(Object.keys(row.counts)).toEqual([
        "operational",
        "under_construction",
        "permitted",
        "proposed",
        "cancelled",
      ]);
    }
  });
});

describe("quarter boundaries", () => {
  it("counts an event dated exactly on the quarter's LAST DAY in that quarter", () => {
    const artifact = build([
      facility({
        id: "boundary",
        status: "operational",
        statusHistory: [{ status: "permitted", date: "2024-03-31" }],
      }),
    ]);

    expect(quarter(artifact, "2024Q1").counts.permitted).toBe(1);
    expect(quarter(artifact, "2024Q1").known).toBe(1);
  });

  it("counts an event dated the FIRST day of the next quarter in that next quarter", () => {
    // The other half of the boundary — without it, an off-by-one that swept
    // everything forward would still pass the assertion above.
    const artifact = build([
      anchor(),
      facility({
        id: "boundary-next",
        status: "operational",
        statusHistory: [{ status: "permitted", date: "2024-04-01" }],
      }),
    ]);

    expect(quarter(artifact, "2024Q1").counts.permitted).toBe(0);
    expect(quarter(artifact, "2024Q1").known).toBe(1);
    expect(quarter(artifact, "2024Q2").counts.permitted).toBe(1);
  });

  it("places a bare-year event in Q1 of that year (start-of-period, rule 5)", () => {
    const artifact = build([
      facility({
        id: "year-only",
        status: "operational",
        statusHistory: [{ status: "proposed", date: "2024" }],
      }),
    ]);

    expect(quarter(artifact, "2024Q1").counts.proposed).toBe(1);
  });
});

describe("window and coverage metadata", () => {
  it("counts pre-window events toward the axis's first quarter without charting them", () => {
    // Windowing trims the AXIS, never the population — a facility whose only
    // event predates the window is still known throughout it.
    const artifact = build([
      facility({
        id: "ancient",
        status: "operational",
        statusHistory: [{ status: "operational", date: "2019-05-01" }],
      }),
    ]);

    expect(artifact.quarters[0].quarter).toBe("2024Q1");
    expect(artifact.quarters[0].counts.operational).toBe(1);
    expect(artifact.coverage.earliestEvent).toBe("2019-05-01");
    expect(artifact.coverage.quartersOmitted).toBe(19);
    expect(artifact.coverage.knownAtStart).toBe(1);
  });

  it("starts the axis at the first event when the data begins INSIDE the window", () => {
    // i.e. it emits NO leading quarters in which nothing is known yet. A run
    // of `known: 0` rows would draw a flat zero baseline, which reads as
    // "there was nothing" when the truth is "nothing was tracked".
    const artifact = build([
      facility({
        id: "recent",
        status: "operational",
        statusHistory: [{ status: "proposed", date: "2024-08-01" }],
      }),
    ]);

    expect(artifact.quarters.map((q) => q.quarter)).toEqual(["2024Q3", "2024Q4"]);
    expect(artifact.coverage.quartersOmitted).toBe(0);
    expect(artifact.coverage.knownAtStart).toBe(1);
  });

  it("flags the in-progress quarter as partial and leaves closed ones unflagged", () => {
    const artifact = buildPipelineHistoryData(
      [
        facility({
          id: "a",
          status: "operational",
          statusHistory: [{ status: "proposed", date: "2024-01-10" }],
        }),
      ],
      { asOf: "2024-11-15T00:00:00.000Z", startQuarter: { year: 2024, quarter: 1 } },
    ) as Artifact;

    expect(artifact.quarters.map((q) => q.quarter)).toEqual([
      "2024Q1",
      "2024Q2",
      "2024Q3",
      "2024Q4",
    ]);
    expect(quarter(artifact, "2024Q3").partial).toBeUndefined();
    expect(quarter(artifact, "2024Q4").partial).toBe(true);
  });

  it("leaves the final quarter UNFLAGGED when asOf lands on its last day", () => {
    // The boundary the test above cannot reach: its asOf is mid-quarter, so a
    // `>=` comparison passes it. A snapshot taken ON 2024-12-31 sees 2024Q4
    // CLOSED, not in progress — flagging it partial would render a complete
    // quarter as provisional on every quarter-end publish.
    const artifact = build([
      facility({
        id: "a",
        status: "operational",
        statusHistory: [{ status: "proposed", date: "2024-01-10" }],
      }),
    ]);

    expect(OPTIONS.asOf.slice(0, 10)).toBe(quarter(artifact, "2024Q4").end);
    expect(quarter(artifact, "2024Q4").partial).toBeUndefined();
  });

  it("records date precision so the consumer can disclose how coarse the dates are", () => {
    const artifact = build([
      facility({
        id: "mixed",
        status: "operational",
        // DISTINCT counts (2 year / 1 month / 3 day). With {1,1,1} the three
        // labels are interchangeable, so a permutation of the precision keys
        // survives the assertion — the fixture coincided with exactly the
        // thing it was meant to distinguish.
        statusHistory: [
          { status: "proposed", date: "2023" },
          { status: "proposed", date: "2024" },
          { status: "permitted", date: "2024-05" },
          { status: "under_construction", date: "2024-09-09" },
          { status: "operational", date: "2024-10-10" },
          { status: "cancelled", date: "2024-11-11" },
        ],
      }),
    ]);

    expect(artifact.coverage.datePrecision).toEqual({ year: 2, month: 1, day: 3 });
    expect(artifact.coverage.unparseableDates).toBe(0);
  });

  it("drops an event whose date names no year, and counts it", () => {
    const artifact = build([
      facility({
        id: "unplaceable",
        status: "operational",
        statusHistory: [
          { status: "proposed", date: "unknown" },
          { status: "permitted", date: "2024-02-01" },
        ],
      }),
    ]);

    expect(artifact.coverage.unparseableDates).toBe(1);
    expect(quarter(artifact, "2024Q1").counts.permitted).toBe(1);
    expect(quarter(artifact, "2024Q1").known).toBe(1);
  });

  it("emits counts, never percentages", () => {
    // Normalising here would lose the denominator on the way to the chart.
    const artifact = build([
      facility({
        id: "a",
        status: "operational",
        statusHistory: [{ status: "proposed", date: "2024-01-01" }],
      }),
      facility({
        id: "b",
        status: "operational",
        statusHistory: [{ status: "operational", date: "2024-01-01" }],
      }),
    ]);

    const row = quarter(artifact, "2024Q1");
    expect(row.counts.proposed).toBe(1);
    expect(row.counts.operational).toBe(1);
    for (const value of Object.values(row.counts)) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("defaults the window start to START_QUARTER when none is supplied", () => {
    const artifact = buildPipelineHistoryData(
      [
        facility({
          id: "old",
          status: "operational",
          statusHistory: [{ status: "operational", date: "2015-01-01" }],
        }),
      ],
      { asOf: "2020-06-30T00:00:00.000Z" },
    ) as Artifact;

    // Literal, not interpolated from START_QUARTER: a test that follows the
    // constant it is pinning cannot detect the constant moving. Moving the
    // axis start is a deliberate decision and should update this line.
    expect(artifact.quarters[0].quarter).toBe("2020Q1");
    expect(START_QUARTER).toEqual({ year: 2020, quarter: 1 });
  });
});

describe("degenerate input", () => {
  it("produces a valid EMPTY artifact rather than throwing on no facilities", () => {
    const artifact = build([]);

    expect(artifact.quarters).toEqual([]);
    // Literal for the same reason as the `counts` keys above.
    expect(artifact.statuses).toEqual([
      "operational",
      "under_construction",
      "permitted",
      "proposed",
      "cancelled",
    ]);
    expect(artifact.coverage.totalFacilities).toBe(0);
    expect(artifact.coverage.withHistory).toBe(0);
    expect(artifact.coverage.excludedNoHistory).toBe(0);
    expect(artifact.coverage.earliestEvent).toBeNull();
  });

  it("produces a valid empty series when nothing has history", () => {
    const artifact = build([facility({ id: "a" }), facility({ id: "b" })]);

    expect(artifact.quarters).toEqual([]);
    expect(artifact.coverage.excludedNoHistory).toBe(2);
  });

  it("throws on a non-array input rather than silently emitting nothing", () => {
    expect(() => buildPipelineHistoryData(null as never)).toThrow(/expected an array/);
  });

  it("ignores an event whose status is not a known Status value", () => {
    const artifact = build([
      facility({
        id: "anchor",
        status: "proposed",
        statusHistory: [{ status: "proposed", date: "2024-01-01" }],
      }),
      facility({
        id: "bogus",
        status: "operational",
        statusHistory: [
          { status: "mothballed", date: "2024-01-01" },
          { status: "operational", date: "2024-05-01" },
        ],
      }),
    ]);

    expect(quarter(artifact, "2024Q1").known).toBe(1);
    expect(quarter(artifact, "2024Q1").counts.proposed).toBe(1);
    expect(quarter(artifact, "2024Q2").counts.operational).toBe(1);
  });
});

/**
 * Rule 5 says start-of-period biases the series EARLIER. These tests are what
 * make that a measured claim rather than an assertion in a comment: the
 * artifact carries the magnitude per quarter, so the chart's caption can cite
 * the data instead of a literal someone copied once (which is how the retired
 * `<=5.2%` figure got into the header in the first place).
 */
describe("ambiguous — the magnitude of rule 5's earlier-than-sourced bias", () => {
  it("flags a year-only facility in every quarter its entry is not yet supported", () => {
    // "2024" resolves to 2024-01-01, so this facility joins the denominator in
    // 2024Q1 — but the source admits any date up to 2024-12-31, so its
    // presence is unsupported until 2024Q4. Three quarters early: the maximum.
    const artifact = build([anchor(), facility({
      id: "year-only",
      status: "proposed",
      statusHistory: [{ status: "proposed", date: "2024" }],
    })]);

    expect(quarter(artifact, "2024Q1").ambiguous).toBe(1);
    expect(quarter(artifact, "2024Q2").ambiguous).toBe(1);
    expect(quarter(artifact, "2024Q3").ambiguous).toBe(1);
    // By 2024Q4 the whole named period has closed, so the entry IS supported.
    expect(quarter(artifact, "2024Q4").ambiguous).toBe(0);
    // It is counted in the denominator throughout regardless — `ambiguous` is
    // a disclosure alongside `known`, never a subtraction from it.
    expect(quarter(artifact, "2024Q1").known).toBe(2);
    expect(quarter(artifact, "2024Q1").counts.proposed).toBe(1);
  });

  it("never flags a facility whose dates are all exact", () => {
    const artifact = build([
      anchor(),
      facility({
        id: "precise",
        status: "operational",
        statusHistory: [
          { status: "proposed", date: "2024-02-14" },
          { status: "operational", date: "2024-08-30" },
        ],
      }),
    ]);

    expect(artifact.quarters.map((q) => q.ambiguous)).toEqual([0, 0, 0, 0]);
  });

  it("does NOT flag a month-only date on its own — a month nests inside a quarter", () => {
    // The obvious paraphrase of rule 5 ("month-only shifts by up to a
    // quarter") is wrong, and this pins the real behaviour: 2024-03 resolves
    // to 2024-03-01 and its period ends 2024-03-31, both inside 2024Q1, so
    // nothing about this facility's row can move.
    const artifact = build([anchor(), facility({
      id: "month-only",
      status: "proposed",
      statusHistory: [{ status: "proposed", date: "2024-03" }],
    })]);

    expect(artifact.quarters.map((q) => q.ambiguous)).toEqual([0, 0, 0, 0]);
    expect(quarter(artifact, "2024Q1").known).toBe(2);
  });

  it("DOES flag a month-only date that reorders two events inside one quarter", () => {
    // 2024-02 (start 2024-02-01, end 2024-02-29) straddles the exact
    // 2024-02-20 event: start-of-period puts `permitted` last and
    // end-of-period puts `proposed` last, so the status shown at 2024Q1's end
    // depends entirely on the resolution choice.
    const artifact = build([anchor(), facility({
      id: "reordered",
      status: "permitted",
      statusHistory: [
        { status: "proposed", date: "2024-02" },
        { status: "permitted", date: "2024-02-20" },
      ],
    })]);

    expect(quarter(artifact, "2024Q1").ambiguous).toBe(1);
    expect(quarter(artifact, "2024Q1").counts.permitted).toBe(1);
  });

  it("flags a status the source does not pin to the quarter, not just an entry", () => {
    // The facility's ENTRY (2023-06-10, exact) is beyond doubt and predates the
    // axis, so nothing here is an entry-support question. It is the later
    // `operational` transition, dated only "2024", that start-of-period drags
    // back to 2024-01-01 — the source admits anything up to 2024-12-31, so the
    // status SHOWN in 2024Q1..Q3 is one the source does not pin there.
    const artifact = build([anchor(), facility({
      id: "late-transition",
      status: "operational",
      statusHistory: [
        { status: "proposed", date: "2023-06-10" },
        { status: "operational", date: "2024" },
      ],
    })]);

    expect(quarter(artifact, "2024Q1").ambiguous).toBe(1);
    expect(quarter(artifact, "2024Q3").ambiguous).toBe(1);
    // Present in the denominator from the very first quarter either way — only
    // the status it is shown IN is in doubt.
    expect(quarter(artifact, "2024Q1").known).toBe(2);
    expect(quarter(artifact, "2024Q1").counts.operational).toBe(2);
    expect(quarter(artifact, "2024Q1").counts.proposed).toBe(0);
    // Once the named year has closed, the transition is supported.
    expect(quarter(artifact, "2024Q4").ambiguous).toBe(0);
  });

  it("emits ambiguous on every quarter, so a consumer never reads undefined", () => {
    const artifact = build([anchor()]);

    for (const row of artifact.quarters) {
      expect(Number.isInteger(row.ambiguous), row.quarter).toBe(true);
    }
  });

  it("never exceeds the denominator it is a share of", () => {
    const artifact = build([
      anchor(),
      facility({
        id: "a",
        status: "proposed",
        statusHistory: [{ status: "proposed", date: "2024" }],
      }),
      facility({
        id: "b",
        status: "permitted",
        statusHistory: [{ status: "permitted", date: "2024" }],
      }),
    ]);

    for (const row of artifact.quarters) {
      expect(row.ambiguous, row.quarter).toBeLessThanOrEqual(row.known);
    }
    expect(quarter(artifact, "2024Q1").ambiguous).toBe(2);
  });
});

/**
 * `ambiguous` is a PARTITION of two disjoint causes, not a union of two
 * overlapping readings. The distinction is not academic: a caption splitting
 * the headline 13.9% has to reconcile, and an earlier revision of the header
 * described the split as a union of two figures that overlapped and did not
 * sum to it. These tests are what keep the header comment and the code from
 * drifting apart again.
 */
describe("ambiguous — the entry/status partition", () => {
  /**
   * DISTINCT component counts (2 entry / 1 status). With {1, 1} the two fields
   * are interchangeable, so a swap of them survives every assertion — the same
   * vacuity trap the datePrecision fixture above documents.
   */
  function partitioned() {
    return build([
      anchor(),
      // ENTRY unsupported: "2024" enters the denominator at 2024Q1 under
      // start-of-period, but its sources admit any day up to 2024-12-31.
      facility({
        id: "year-only-a",
        status: "proposed",
        statusHistory: [{ status: "proposed", date: "2024" }],
      }),
      facility({
        id: "year-only-b",
        status: "permitted",
        statusHistory: [{ status: "permitted", date: "2024" }],
      }),
      // STATUS differs: entry is exact and predates the axis, so its presence
      // is never in doubt — only the status it is shown in.
      facility({
        id: "late-transition",
        status: "operational",
        statusHistory: [
          { status: "proposed", date: "2023-06-10" },
          { status: "operational", date: "2024" },
        ],
      }),
    ]);
  }

  it("splits ambiguous into an unsupported ENTRY and a differing STATUS", () => {
    const row = quarter(partitioned(), "2024Q1");

    expect(row.ambiguousEntry).toBe(2);
    expect(row.ambiguousStatus).toBe(1);
    expect(row.ambiguous).toBe(3);
    expect(row.known).toBe(4);
  });

  it("sums to ambiguous in EVERY quarter — the invariant a caption relies on", () => {
    const artifact = partitioned();

    for (const row of artifact.quarters) {
      expect(row.ambiguousEntry + row.ambiguousStatus, row.quarter).toBe(row.ambiguous);
    }
    // Non-vacuity: the invariant must not hold only over all-zero quarters,
    // and each component must be exercised on its own somewhere in the series.
    expect(artifact.quarters.some((q) => q.ambiguousEntry > 0)).toBe(true);
    expect(artifact.quarters.some((q) => q.ambiguousStatus > 0)).toBe(true);
    expect(artifact.quarters.some((q) => q.ambiguous > 0)).toBe(true);
  });

  it("counts a facility ONCE, in whichever component applies", () => {
    // Disjointness: the two components can never double-count, so neither can
    // exceed `ambiguous` and neither can push their sum past `known`.
    for (const row of partitioned().quarters) {
      expect(row.ambiguousEntry, row.quarter).toBeLessThanOrEqual(row.ambiguous);
      expect(row.ambiguousStatus, row.quarter).toBeLessThanOrEqual(row.ambiguous);
      expect(row.ambiguous, row.quarter).toBeLessThanOrEqual(row.known);
    }
  });

  it("emits both components on every quarter, so a consumer never reads undefined", () => {
    for (const row of build([anchor()]).quarters) {
      expect(Number.isInteger(row.ambiguousEntry), row.quarter).toBe(true);
      expect(Number.isInteger(row.ambiguousStatus), row.quarter).toBe(true);
    }
  });
});

/**
 * Two same-day events resolve by CURATOR ORDER (position in the source array).
 * That is a real decision — it picks which status wins the quarter — and both
 * comparators were previously asserted only in a comment. Reversing either one
 * looks like a no-op refactor and moves the captioned peak by over a
 * percentage point, so each gets its own fixture, deliberately ordered.
 */
describe("curator-order tie-breaks", () => {
  it("resolves a same-DAY tie in favour of the later array entry", () => {
    // Both events resolve to day 2024-02-01: the exact date, and the 1st of the
    // month for the month-only one. Curator order is the ONLY thing separating
    // them, and `permitted` is written second, so `permitted` wins 2024Q1.
    const artifact = build([
      anchor(),
      facility({
        id: "same-day-tie",
        status: "permitted",
        statusHistory: [
          { status: "proposed", date: "2024-02-01" },
          { status: "permitted", date: "2024-02" },
        ],
      }),
    ]);

    expect(quarter(artifact, "2024Q1").counts.permitted).toBe(1);
    expect(quarter(artifact, "2024Q1").counts.proposed).toBe(0);
    // The two periodEnds differ (02-01 vs 02-29), so the counterfactual sort
    // does NOT tie here — this fixture isolates the `events` comparator.
    expect(quarter(artifact, "2024Q1").ambiguous).toBe(0);
  });

  it("resolves a same-PERIOD-END tie in the counterfactual the same way", () => {
    // The counterfactual sort ties where the real one does not: `2024-02` ends
    // 2024-02-29, exactly the other event's day. Curator order puts `permitted`
    // last there, while the real sort (by day: 02-01 then 02-29) puts
    // `proposed` last — so the quarter is flagged ambiguous.
    const artifact = build([
      anchor(),
      facility({
        id: "same-period-end-tie",
        status: "proposed",
        statusHistory: [
          { status: "proposed", date: "2024-02-29" },
          { status: "permitted", date: "2024-02" },
        ],
      }),
    ]);

    // The bar does not move — this comparator only ever moves `ambiguous`,
    // which is precisely why nothing caught it before.
    expect(quarter(artifact, "2024Q1").counts.proposed).toBe(1);
    expect(quarter(artifact, "2024Q1").ambiguous).toBe(1);
    expect(quarter(artifact, "2024Q1").ambiguousStatus).toBe(1);
    expect(quarter(artifact, "2024Q1").ambiguousEntry).toBe(0);
  });
});

describe("coverage.ambiguousPeak", () => {
  it("names the quarter with the worst SHARE, not the biggest raw count", () => {
    // 2024Q1 is 1/2 ambiguous; a later quarter has a larger population and a
    // larger raw count but a smaller share. Peaking on the count would name
    // the wrong quarter and understate the distortion.
    const quarters = [
      { quarter: "2024Q1", known: 2, ambiguous: 1, ambiguousEntry: 1, ambiguousStatus: 0 },
      { quarter: "2024Q2", known: 100, ambiguous: 10, ambiguousEntry: 6, ambiguousStatus: 4 },
    ];

    expect(peakAmbiguous(quarters)).toEqual({
      quarter: "2024Q1",
      count: 1,
      entry: 1,
      status: 0,
      known: 2,
      share: 50,
    });
  });

  it("rounds the share to one decimal", () => {
    expect(
      peakAmbiguous([
        { quarter: "2025Q1", known: 373, ambiguous: 52, ambiguousEntry: 36, ambiguousStatus: 16 },
      ]),
    ).toEqual({
      quarter: "2025Q1",
      count: 52,
      entry: 36,
      status: 16,
      known: 373,
      share: 13.9,
    });
  });

  it("carries the entry/status split through, so a split caption reconciles", () => {
    // The headline share is what gets captioned, and a caption that splits it
    // has to reconcile — copying the parts out of a comment is how the retired
    // 9.9%/12.3% pair got into the header. DISTINCT parts, so a swap of the two
    // fields cannot survive.
    const peak = peakAmbiguous([
      { quarter: "2025Q1", known: 373, ambiguous: 52, ambiguousEntry: 36, ambiguousStatus: 16 },
    ]);

    expect(peak?.entry).toBe(36);
    expect(peak?.status).toBe(16);
    expect(peak!.entry + peak!.status).toBe(peak!.count);
  });

  it("resolves a tie to the EARLIEST quarter so rebuilds are stable", () => {
    const peak = peakAmbiguous([
      { quarter: "2024Q1", known: 10, ambiguous: 2, ambiguousEntry: 2, ambiguousStatus: 0 },
      { quarter: "2024Q2", known: 20, ambiguous: 4, ambiguousEntry: 4, ambiguousStatus: 0 },
    ]);

    expect(peak?.quarter).toBe("2024Q1");
  });

  it("skips an empty quarter rather than dividing by zero", () => {
    const peak = peakAmbiguous([
      { quarter: "2024Q1", known: 0, ambiguous: 0, ambiguousEntry: 0, ambiguousStatus: 0 },
      { quarter: "2024Q2", known: 4, ambiguous: 1, ambiguousEntry: 0, ambiguousStatus: 1 },
    ]);

    expect(peak).toEqual({
      quarter: "2024Q2",
      count: 1,
      entry: 0,
      status: 1,
      known: 4,
      share: 25,
    });
  });

  it("is null when there is no quarter with a denominator", () => {
    expect(peakAmbiguous([])).toBeNull();
    expect(
      peakAmbiguous([
        { quarter: "2024Q1", known: 0, ambiguous: 0, ambiguousEntry: 0, ambiguousStatus: 0 },
      ]),
    ).toBeNull();
  });

  it("agrees with the quarter row it names", () => {
    const artifact = build([
      anchor(),
      facility({
        id: "year-only",
        status: "proposed",
        statusHistory: [{ status: "proposed", date: "2024" }],
      }),
    ]);
    const peak = artifact.coverage.ambiguousPeak;
    const row = quarter(artifact, peak!.quarter);

    expect(peak!.count).toBe(row.ambiguous);
    expect(peak!.known).toBe(row.known);
    expect(peak!.share).toBe(50);
    expect(peak!.entry).toBe(row.ambiguousEntry);
    expect(peak!.status).toBe(row.ambiguousStatus);
  });
});

/**
 * The three fail-loud guards on the WRITE path. Each exists to stop a silently
 * wrong artifact reaching the chart, and an unexercised guard is
 * indistinguishable from one that cannot fire — so each is exported and driven
 * directly rather than left to `buildPipelineHistory`'s fixed file paths.
 */
describe("write-path guards", () => {
  describe("assertUsableAsOf", () => {
    it("accepts and returns an ISO-8601 instant", () => {
      expect(assertUsableAsOf("2026-09-15T12:00:00.000Z")).toBe("2026-09-15T12:00:00.000Z");
      expect(assertUsableAsOf("2026-09-15T12:00:00Z")).toBe("2026-09-15T12:00:00Z");
    });

    it("rejects a bare day, which would leave the last quarter underivable", () => {
      expect(() => assertUsableAsOf("2026-09-15")).toThrow(/no usable `asOf`/);
    });

    it("rejects a missing, null or non-string value", () => {
      expect(() => assertUsableAsOf(undefined)).toThrow(/no usable `asOf`/);
      expect(() => assertUsableAsOf(null)).toThrow(/no usable `asOf`/);
      expect(() => assertUsableAsOf(1757937600000)).toThrow(/no usable `asOf`/);
    });

    it("rejects a non-UTC instant rather than guessing an offset", () => {
      expect(() => assertUsableAsOf("2026-09-15T12:00:00+01:00")).toThrow(/no usable `asOf`/);
    });

    it("names this tool, not the sibling build script it mirrors", () => {
      // The near-duplicate in build-hero-plate.mjs throws a message prefixed
      // `build-hero-plate:`; importing it would make this script's failures
      // point at the wrong file.
      expect(() => assertUsableAsOf("nope")).toThrow(/^build-pipeline-history:/);
    });

    it("quotes the offending value so the failure is diagnosable", () => {
      expect(() => assertUsableAsOf("nope")).toThrow(/"nope"/);
    });
  });

  describe("assertHasQuarters", () => {
    it("refuses to write an empty series that would blank the chart", () => {
      expect(() => assertHasQuarters([])).toThrow(/produced 0 quarters/);
    });

    it("passes a non-empty series through unchanged", () => {
      const quarters = [{ quarter: "2024Q1", known: 1, ambiguous: 0, counts: {} }];
      expect(assertHasQuarters(quarters)).toBe(quarters);
    });
  });

  describe("assertReconciled", () => {
    it("throws when the status counts do not sum to the denominator", () => {
      expect(() =>
        assertReconciled([
          {
            quarter: "2024Q2",
            known: 5,
            counts: {
              operational: 1,
              under_construction: 1,
              permitted: 0,
              proposed: 0,
              cancelled: 0,
            },
          },
        ]),
      ).toThrow(/reconciliation failed at 2024Q2 — status counts sum to 2 but known is 5/);
    });

    it("throws when the counts EXCEED the denominator, not only when short", () => {
      expect(() =>
        assertReconciled([
          {
            quarter: "2024Q3",
            known: 1,
            counts: {
              operational: 2,
              under_construction: 0,
              permitted: 0,
              proposed: 0,
              cancelled: 0,
            },
          },
        ]),
      ).toThrow(/sum to 2 but known is 1/);
    });

    it("ignores a status key outside STATUS_ORDER when summing", () => {
      // A stray key must not be able to silently satisfy the invariant.
      expect(() =>
        assertReconciled([
          {
            quarter: "2024Q4",
            known: 1,
            counts: {
              operational: 0,
              under_construction: 0,
              permitted: 0,
              proposed: 0,
              cancelled: 0,
              mothballed: 1,
            },
          },
        ]),
      ).toThrow(/sum to 0 but known is 1/);
    });

    it("passes a consistent series through, including an all-zero quarter", () => {
      const quarters = [
        {
          quarter: "2024Q1",
          known: 0,
          counts: {
            operational: 0,
            under_construction: 0,
            permitted: 0,
            proposed: 0,
            cancelled: 0,
          },
        },
      ];
      expect(assertReconciled(quarters)).toBe(quarters);
    });

    it("holds over every quarter a real build produces", () => {
      const artifact = build([
        anchor(),
        facility({
          id: "mixed",
          status: "operational",
          statusHistory: [
            { status: "proposed", date: "2024" },
            { status: "operational", date: "2024-07-01" },
          ],
        }),
      ]);

      expect(() => assertReconciled(artifact.quarters)).not.toThrow();
    });
  });
});
