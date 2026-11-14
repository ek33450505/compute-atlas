import { describe, expect, it } from "vitest";

import { CSV_COLUMNS, CSV_COLUMN_NOTES, facilitiesToCsv } from "@/lib/dataset-csv";
import { facilitySchema, type Facility } from "@/lib/schema";

/** Minimal RFC 4180 parser (quoted cells, doubled quotes, CRLF/LF inside quotes) so the round trip needs no dependency. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const base = {
  confidence: "confirmed",
  sources: [{ url: "https://example.com/a", label: "A", retrievedAt: "2026-11-01" }],
  lastUpdated: "2026-11-01",
};

const make = (over: Record<string, unknown>): Facility =>
  facilitySchema.parse({
    ...base,
    id: "fx",
    name: "Fx",
    operator: "Op",
    status: "operational",
    location: { lat: 40, lon: -97.5, state: "NE" },
    facilityType: "data_center",
    ...over,
  });

const dataCenter = make({
  id: "dc-1",
  name: "Campus, \"North\"\r\nWing",
  operator: "Zeta Corp",
  location: { lat: 40.1, lon: -97.5, city: "Omaha", county: "Douglas", state: "NE", precision: "exact" },
  capacityMw: { operational: 120, planned: 300 },
  energy: { source: "grid", utility: "OPPD", onSiteGenerationMw: 5 },
  water: { coolingType: "closed_loop", reportedMgd: 0.5 },
  jobs: { construction: 200, permanent: 40 },
  investmentUsd: 1500000000,
  aiClassification: "confirmed",
  environmental: { pue: 1.2, wue: 0.3, renewablePercent: 80, waterStress: "low" },
  sources: [
    { url: "https://example.com/a", label: "A", retrievedAt: "2026-11-01" },
    { url: "https://example.com/b;x=1", label: "B", retrievedAt: "2026-11-01" },
  ],
});
const mining = make({
  id: "mine-1",
  name: "Mine One",
  facilityType: "crypto_mining",
  status: "proposed",
  mining: { hashRateThPerS: 1000, hardwareType: "asic", coolingType: "immersion", powerArrangement: "flared_gas" },
  environmental: { carbonIntensityProxy: 0.4, carbonIntensityBasis: "estimated" },
});
const power = make({
  id: "pg-1",
  name: "Plant",
  facilityType: "power_generation",
  status: "under_construction",
  location: { lat: 35, lon: -90, state: "AR", multiSite: { states: ["AR", "OK"] } },
  generation: { technology: "natural_gas", offtaker: "Meta (via Entergy)", unitCount: 2, poweredFacilityIds: ["dc-1", "mine-1"] },
});

const col = (name: string) => {
  const i = CSV_COLUMNS.indexOf(name);
  if (i < 0) throw new Error(`no column ${name}`);
  return i;
};
const cellsOf = (facilities: Facility[]) => parseCsv(facilitiesToCsv(facilities)).slice(1);

describe("facilitiesToCsv", () => {
  it("pins the literal header: the column list is a public format", () => {
    // Deliberately written out, not derived from CSV_COLUMNS: adding, removing, renaming or
    // reordering a column breaks every downstream consumer, so the change must be made here too.
    const expected = [
      "id",
      "name",
      "facilityType",
      "status",
      "confidence",
      "operator",
      "location.state",
      "location.city",
      "location.county",
      "location.street",
      "location.postalCode",
      "location.lat",
      "location.lon",
      "location.precision",
      "location.multiSite.states",
      "capacityMw.operational",
      "capacityMw.planned",
      "poweredBy",
      "announcedDate",
      "lastUpdated",
      "energy.source",
      "energy.utility",
      "energy.onSiteGenerationMw",
      "water.coolingType",
      "water.reportedMgd",
      "investmentUsd",
      "landAcres",
      "jobs.construction",
      "jobs.permanent",
      "community.status",
      "aiClassification",
      "environmental.pue",
      "environmental.pueConfidence",
      "environmental.wue",
      "environmental.gridCarbonIntensityGCo2PerKwh",
      "environmental.renewablePercent",
      "environmental.waterStress",
      "mining.hashRateThPerS",
      "mining.hardwareType",
      "mining.coolingType",
      "mining.powerArrangement",
      "environmental.carbonIntensityProxy",
      "environmental.carbonIntensityBasis",
      "generation.technology",
      "generation.offtaker",
      "generation.unitCount",
      "generation.poweredFacilityIds",
      "sources.url",
      // schema v2, appended after the original 48 so positional parsers keep working
      "ids.epaFrsId",
      "ids.eiaPlantId",
      "energy.utilityEiaId",
      "capacityMw.basis",
      "capacityMw.itOperational",
      "capacityMw.itPlanned",
      "parties.ownerEntity",
      "parties.tenant",
      "parties.endUser",
      "parties.generalContractor",
      "construction.expectedStart",
      "construction.expectedCompletion",
      "construction.permitValuationUsd",
      "construction.disturbedAcres",
      "construction.receivingWater",
      "construction.receivingWater.segment",
    ];
    expect(CSV_COLUMNS).toEqual(expected);
    const csv = facilitiesToCsv([dataCenter]);
    expect(parseCsv(csv)[0]).toEqual(expected);
    expect(csv.startsWith(`${expected.join(",")}\r\n`)).toBe(true);
  });

  it("has unique column names", () => {
    expect(new Set(CSV_COLUMNS).size).toBe(CSV_COLUMNS.length);
  });

  it("writes one row per facility, every row CSV_COLUMNS.length cells wide, in input order", () => {
    const rows = cellsOf([dataCenter, mining, power]);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toHaveLength(CSV_COLUMNS.length);
    expect(rows.map((r) => r[col("id")])).toEqual(["dc-1", "mine-1", "pg-1"]);
  });

  it("emits only the header for no facilities", () => {
    expect(facilitiesToCsv([])).toBe(`${CSV_COLUMNS.join(",")}\r\n`);
  });

  it("uses CRLF line endings, ends with CRLF, and has no BOM", () => {
    const csv = facilitiesToCsv([mining]);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    expect(csv.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/);
  });

  it("recovers a cell with an embedded comma, double quote and CRLF exactly", () => {
    const [row] = cellsOf([dataCenter]);
    expect(row[col("name")]).toBe('Campus, "North"\r\nWing');
    expect(facilitiesToCsv([dataCenter])).toContain('"Campus, ""North""\r\nWing"');
  });

  it("round-trips the data center's scalar cells", () => {
    const [row] = cellsOf([dataCenter]);
    const at = (name: string) => row[col(name)];
    expect(at("facilityType")).toBe("data_center");
    expect(at("location.city")).toBe("Omaha");
    expect(at("location.lat")).toBe("40.1");
    expect(at("location.lon")).toBe("-97.5");
    expect(at("location.precision")).toBe("exact");
    expect(at("capacityMw.operational")).toBe("120");
    expect(at("capacityMw.planned")).toBe("300");
    expect(at("energy.utility")).toBe("OPPD");
    expect(at("water.coolingType")).toBe("closed_loop");
    expect(at("investmentUsd")).toBe("1500000000");
    expect(at("environmental.pue")).toBe("1.2");
    expect(at("environmental.waterStress")).toBe("low");
    expect(at("aiClassification")).toBe("confirmed");
  });

  it("joins sources with ';' and keeps a literal ';' in a URL from splitting the list", () => {
    const [row] = cellsOf([dataCenter]);
    expect(row[col("sources.url")]).toBe("https://example.com/a;https://example.com/b%3Bx=1");
  });

  it("fills variant-specific columns only for their own facilityType", () => {
    const [dc, mine, plant] = cellsOf([dataCenter, mining, power]);
    expect(mine[col("mining.hardwareType")]).toBe("asic");
    expect(mine[col("mining.hashRateThPerS")]).toBe("1000");
    expect(mine[col("environmental.carbonIntensityBasis")]).toBe("estimated");
    expect(mine[col("environmental.pue")]).toBe("");
    expect(mine[col("generation.technology")]).toBe("");
    expect(dc[col("mining.hardwareType")]).toBe("");
    expect(dc[col("generation.technology")]).toBe("");
    expect(dc[col("environmental.carbonIntensityProxy")]).toBe("");
    expect(plant[col("generation.technology")]).toBe("natural_gas");
    expect(plant[col("generation.offtaker")]).toBe("Meta (via Entergy)");
    expect(plant[col("generation.unitCount")]).toBe("2");
    expect(plant[col("generation.poweredFacilityIds")]).toBe("dc-1;mine-1");
    expect(plant[col("location.multiSite.states")]).toBe("AR;OK");
    expect(plant[col("aiClassification")]).toBe("");
    expect(plant[col("mining.hardwareType")]).toBe("");
  });

  it("writes absent optional fields as empty cells", () => {
    const [row] = cellsOf([make({ id: "bare", name: "Bare" })]);
    for (const name of ["location.city", "capacityMw.operational", "energy.source", "water.reportedMgd", "jobs.permanent"]) {
      expect(row[col(name)]).toBe("");
    }
    expect(row[col("id")]).toBe("bare");
  });

  describe("CSV-injection guard", () => {
    it("prefixes a string cell that starts with a formula character", () => {
      const name = '=HYPERLINK("http://evil.example","x")';
      const [row] = cellsOf([make({ name })]);
      expect(row[col("name")]).toBe(`'${name}`);
      for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
        const [r] = cellsOf([make({ name: `${lead}cmd` })]);
        expect(r[col("name")]).toBe(`'${lead}cmd`);
      }
    });

    it("prefixes a string starting with '-' but leaves a negative number alone", () => {
      const [row] = cellsOf([make({ operator: "-Dash Co", location: { lat: -33.5, lon: -97.5, state: "NE" } })]);
      expect(row[col("operator")]).toBe("'-Dash Co");
      expect(row[col("location.lon")]).toBe("-97.5");
      expect(row[col("location.lat")]).toBe("-33.5");
    });

    it("does not prefix text that merely contains a formula character", () => {
      const [row] = cellsOf([make({ name: "A=B + C @ D" })]);
      expect(row[col("name")]).toBe("A=B + C @ D");
    });

    it("guards a joined multi-value cell by its first element", () => {
      const plant = make({
        id: "pg-2",
        facilityType: "power_generation",
        generation: { poweredFacilityIds: ["-odd", "ok"] },
      });
      const [row] = cellsOf([plant]);
      expect(row[col("generation.poweredFacilityIds")]).toBe("'-odd;ok");
    });
  });
});

describe("schema v2 columns", () => {
  const v2 = make({
    id: "dc-v2",
    capacityMw: { operational: 100, basis: "it", itOperational: 90, itPlanned: 150 },
    energy: { utility: "OPPD", utilityEiaId: { id: 14127, sourceIndex: 0 } },
    ids: { epaFrsId: { id: "110000123456", sourceIndex: 0 }, eiaPlantId: { id: 5555, sourceIndex: 0 } },
    parties: {
      ownerEntity: [
        { name: "Alpha LLC", sourceIndex: 0 },
        { name: "Beta; Gamma Inc", sourceIndex: 0 },
      ],
      tenant: [{ name: "=Evil Tenant", sourceIndex: 0 }],
      endUser: [{ name: "Meta", sourceIndex: 0 }],
      generalContractor: [{ name: "Build Co", sourceIndex: 0 }],
    },
    construction: {
      expectedStart: { date: "2026-03", sourceIndex: 0 },
      expectedCompletion: { date: "2028", sourceIndex: 0 },
      permitValuationUsd: { amountUsd: 250000000, permitNumber: "B-1", sourceIndex: 0 },
      disturbedAcres: { value: 304.5, sourceIndex: 0 },
      receivingWater: { name: "Brushy Creek", segment: "0828", sourceIndex: 0 },
      phases: [{ name: "Phase 1", sourceIndex: 0 }],
    },
  });
  const legacy = make({ id: "legacy" });
  const first = CSV_COLUMNS.indexOf("ids.epaFrsId");

  it("appends the 16 v2 columns last", () => {
    expect(first).toBe(CSV_COLUMNS.length - 16);
    expect(CSV_COLUMNS[first - 1]).toBe("sources.url");
  });

  it("renders every v2 value, ;-joining parties and escaping ; and formulas", () => {
    const [row] = cellsOf([v2]);
    expect(row.slice(first)).toEqual([
      "110000123456",
      "5555",
      "14127",
      "it",
      "90",
      "150",
      "Alpha LLC;Beta%3B Gamma Inc",
      "'=Evil Tenant",
      "Meta",
      "Build Co",
      "2026-03",
      "2028",
      "250000000",
      "304.5",
      "Brushy Creek",
      "0828",
    ]);
  });

  it("leaves 16 empty trailing cells on a legacy facility", () => {
    const [row] = cellsOf([legacy]);
    expect(row).toHaveLength(CSV_COLUMNS.length);
    expect(row.slice(first)).toEqual(Array(16).fill(""));
  });
});

describe("CSV_COLUMN_NOTES", () => {
  it("has a non-empty note for exactly the CSV columns, no more and no fewer", () => {
    expect(Object.keys(CSV_COLUMN_NOTES).sort()).toEqual([...CSV_COLUMNS].sort());
    for (const column of CSV_COLUMNS) expect(CSV_COLUMN_NOTES[column]?.trim()).toBeTruthy();
  });
});
