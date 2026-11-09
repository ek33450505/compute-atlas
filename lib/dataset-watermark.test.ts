import { describe, expect, it } from "vitest";

import { facilitiesToCsv } from "@/lib/dataset-csv";
import {
  drawBelow,
  WatermarkError,
  watermarkCsv,
  watermarkJsonArray,
  watermarkPermutation,
  type WatermarkKey,
} from "@/lib/dataset-watermark";
import { facilitySchema, type Facility } from "@/lib/schema";

const KEY: WatermarkKey = {
  secret: "test-secret-do-not-use",
  grantId: "11111111-1111-4111-8111-111111111111",
  editionId: "22222222-2222-4222-8222-222222222222",
};

const identity = (n: number) => Array.from({ length: n }, (_, i) => i);

const make = (id: string, over: Record<string, unknown> = {}): Facility =>
  facilitySchema.parse({
    confidence: "confirmed",
    sources: [{ url: `https://example.com/${id}`, label: "A", retrievedAt: "2026-11-01" }],
    lastUpdated: "2026-11-01",
    id,
    name: `Site ${id}`,
    operator: "Op",
    status: "operational",
    location: { lat: 40, lon: -97.5, state: "NE" },
    facilityType: "data_center",
    ...over,
  });

/** Sorted by id, the edition builder's base order. A name with a comma, quotes and CRLF forces a quoted multi-line CSV cell. */
const facilities: Facility[] = [
  make("a-1"),
  make("b-2", { name: 'Campus, "North"\r\nWing' }),
  make("c-3"),
  make("d-4"),
  make("e-5", { name: "Line\nbreak, only" }),
  make("f-6"),
  make("g-7"),
];

/** A minimal RFC 4180 parser, so the CSV order can be mapped back to ids without a dependency. */
function csvIds(text: string): string[] {
  const ids: string[] = [];
  let cell = "";
  let quoted = false;
  let first = true;
  let atRecordStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === "," && atRecordStart) {
      if (first) first = false;
      else ids.push(cell);
      cell = "";
      atRecordStart = false;
    } else if (ch === "\r" && text[i + 1] === "\n") {
      i++;
      atRecordStart = true;
      cell = "";
    } else if (atRecordStart) {
      cell += ch;
    }
  }
  return ids;
}

describe("watermarkPermutation", () => {
  it("is deterministic in (key, n)", () => {
    expect(watermarkPermutation(50, KEY)).toEqual(watermarkPermutation(50, { ...KEY }));
  });

  it("changes with the grant id, the edition id and the secret", () => {
    const base = watermarkPermutation(40, KEY);
    expect(watermarkPermutation(40, { ...KEY, grantId: "33333333-3333-4333-8333-333333333333" })).not.toEqual(base);
    expect(watermarkPermutation(40, { ...KEY, editionId: "44444444-4444-4444-8444-444444444444" })).not.toEqual(base);
    expect(watermarkPermutation(40, { ...KEY, secret: "another-secret" })).not.toEqual(base);
  });

  it("is a permutation of 0..n-1", () => {
    for (const n of [2, 3, 17, 500]) {
      const perm = watermarkPermutation(n, KEY);
      expect(perm).toHaveLength(n);
      expect([...perm].sort((a, b) => a - b)).toEqual(identity(n));
    }
  });

  it("handles n = 0 and n = 1", () => {
    expect(watermarkPermutation(0, KEY)).toEqual([]);
    expect(watermarkPermutation(1, KEY)).toEqual([0]);
  });

  it("rejects an invalid n", () => {
    expect(() => watermarkPermutation(-1, KEY)).toThrow(RangeError);
    expect(() => watermarkPermutation(1.5, KEY)).toThrow(RangeError);
  });

  it("throws watermark_no_secret on an empty secret, message = code", () => {
    for (const call of [
      () => watermarkPermutation(5, { ...KEY, secret: "" }),
      () => watermarkJsonArray("[]\n", { ...KEY, secret: "" }),
      () => watermarkCsv("id\r\n", { ...KEY, secret: "" }),
    ]) {
      let caught: unknown;
      try {
        call();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(WatermarkError);
      expect((caught as WatermarkError).code).toBe("watermark_no_secret");
      expect((caught as WatermarkError).message).toBe("watermark_no_secret");
    }
  });

  it("matches the pinned known-answer vector: the trace tool must recompute old editions forever", () => {
    // Pinned from an independent re-implementation (plain node:crypto script, no import of the
    // module). NEVER edit this to make a change pass: a different result means every shipped
    // edition's watermark is no longer reproducible.
    expect(watermarkPermutation(10, KEY)).toEqual([5, 7, 2, 6, 3, 1, 8, 0, 4, 9]);
  });

  it("spreads the 6 orders of n = 3 across 600 grants (uniformity smoke test)", () => {
    const counts = new Map<string, number>();
    for (let g = 0; g < 600; g++) {
      const order = watermarkPermutation(3, { ...KEY, grantId: `grant-${g}` }).join("");
      counts.set(order, (counts.get(order) ?? 0) + 1);
    }
    expect(counts.size).toBe(6);
    // Expected 100 each, sd ~9: [50, 150] is a loose band that a broken shuffle (e.g. 4-of-6) still fails.
    for (const c of counts.values()) {
      expect(c).toBeGreaterThan(50);
      expect(c).toBeLessThan(150);
    }
  });
});

describe("drawBelow (rejection sampling)", () => {
  const scripted = (...values: number[]): Iterator<number> => values[Symbol.iterator]();

  it("redraws a value at or above the limit instead of folding it back with a modulo", () => {
    // range 3: limit = floor(2^32 / 3) * 3 = 4294967295, so 4294967295 is rejected (a plain
    // modulo would return 0 and over-weight residue 0) and the next draw, 7, gives 7 % 3 = 1.
    expect(drawBelow(3, scripted(4294967295, 7))).toBe(1);
    expect(drawBelow(3, scripted(4294967295, 4294967295, 8))).toBe(2);
  });

  it("accepts the largest value below the limit", () => {
    expect(drawBelow(3, scripted(4294967294))).toBe(4294967294 % 3);
  });

  it("never rejects a power-of-two range", () => {
    expect(drawBelow(4, scripted(4294967295))).toBe(3);
  });
});

describe("watermarkJsonArray", () => {
  const body = JSON.stringify(facilities, null, 2) + "\n";

  it("reorders by the permutation, preserving elements and byte length", () => {
    const out = watermarkJsonArray(body, KEY);
    const perm = watermarkPermutation(facilities.length, KEY);
    const parsed = JSON.parse(out) as Facility[];
    expect(parsed.map((f) => f.id)).toEqual(perm.map((i) => facilities[i].id));
    expect([...parsed.map((f) => f.id)].sort()).toEqual(facilities.map((f) => f.id));
    expect(Buffer.byteLength(out)).toBe(Buffer.byteLength(body));
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toBe(JSON.stringify(perm.map((i) => facilities[i]), null, 2) + "\n");
  });

  it("differs from the base order for a real key and is stable per key", () => {
    expect(watermarkJsonArray(body, KEY)).not.toBe(body);
    expect(watermarkJsonArray(body, KEY)).toBe(watermarkJsonArray(body, KEY));
  });

  it("handles an empty array", () => {
    expect(watermarkJsonArray("[]\n", KEY)).toBe("[]\n");
  });

  it.each([["{}\n"], ['"x"\n'], ["null"], ["not json"], [""]])("throws watermark_parse_failed on %j", (bad) => {
    let caught: unknown;
    try {
      watermarkJsonArray(bad, KEY);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WatermarkError);
    expect((caught as WatermarkError).code).toBe("watermark_parse_failed");
    expect((caught as WatermarkError).message).toBe("watermark_parse_failed");
  });
});

describe("watermarkCsv", () => {
  const body = facilitiesToCsv(facilities);

  it("keeps the header first, preserves byte length and CRLF terminators", () => {
    const out = watermarkCsv(body, KEY);
    expect(out.split("\r\n")[0]).toBe(body.split("\r\n")[0]);
    expect(Buffer.byteLength(out)).toBe(Buffer.byteLength(body));
    expect(out.endsWith("\r\n")).toBe(true);
    expect(out).not.toBe(body);
  });

  it("keeps a record with an embedded CRLF in a quoted cell intact", () => {
    const out = watermarkCsv(body, KEY);
    expect(out).toContain('"Campus, ""North""\r\nWing"');
    expect(out).toContain('"Line\nbreak, only"');
    expect(csvIds(out).sort()).toEqual(facilities.map((f) => f.id));
  });

  it("orders data records exactly like the JSON file for the same key (the trace tool relies on it)", () => {
    const jsonIds = (JSON.parse(watermarkJsonArray(JSON.stringify(facilities, null, 2) + "\n", KEY)) as Facility[]).map(
      (f) => f.id,
    );
    expect(csvIds(watermarkCsv(body, KEY))).toEqual(jsonIds);
  });

  it("handles a header-only CSV", () => {
    expect(watermarkCsv("id,name\r\n", KEY)).toBe("id,name\r\n");
  });

  it.each([
    ["unbalanced quote", 'id,name\r\nx,"open\r\n'],
    ["missing final CRLF", "id,name\r\nx,y"],
    ["empty body", ""],
    ["lone LF terminators", "id,name\nx,y\n"],
  ])("throws watermark_parse_failed on %s", (_label, bad) => {
    let caught: unknown;
    try {
      watermarkCsv(bad, KEY);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WatermarkError);
    expect((caught as WatermarkError).code).toBe("watermark_parse_failed");
    expect((caught as WatermarkError).message).toBe("watermark_parse_failed");
  });
});
