import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { DCTE_PROVENANCE, DCTE_ROWS } from "./odod-dcte-2026-11";

const FILE = join(process.cwd(), "public/sources/odod-dcte-2026-11.xlsx");

describe("odod-dcte-2026-11 rows", () => {

  it("has unique, sequential anchors", () => {
    expect(DCTE_ROWS.map((r) => r.anchor)).toEqual(
      DCTE_ROWS.map((_, i) => `row-${i + 1}`),
    );
  });

  it("has valid ISO approval dates", () => {
    for (const r of DCTE_ROWS) {
      expect(r.approvalDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const d = new Date(`${r.approvalDate}T00:00:00Z`);
      expect(d.toISOString().slice(0, 10)).toBe(r.approvalDate);
    }
  });

  it("keeps termYears as a string", () => {
    expect(DCTE_ROWS.some((r) => r.termYears === "15 (up to 40)")).toBe(true);
  });
});

describe("hosted spreadsheet", () => {
  it("matches the pinned SHA-256 and size", () => {
    const bytes = readFileSync(FILE);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(DCTE_PROVENANCE.sha256);
    expect(statSync(FILE).size).toBe(DCTE_PROVENANCE.byteSize);
  });
});

/**
 * Minimal .xlsx reader (node:zlib only). An .xlsx is a ZIP: the central
 * directory at the end lists each entry's name, compressed size and local
 * header offset; each local header is followed by the raw-deflate data.
 */
function readZipEntry(zip: Buffer, name: string): string {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    if (zip.toString("utf8", p + 46, p + 46 + nameLen) === name) {
      const dataStart =
        localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
      const raw = zip.subarray(dataStart, dataStart + compSize);
      if (method === 0) return raw.toString("utf8");
      if (method === 8) return inflateRawSync(raw).toString("utf8");
      throw new Error(`unsupported zip method ${method} for ${name}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${name} not found in xlsx`);
}

const unescapeXml = (t: string) =>
  t
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** Shared-string table: each <si> is the concatenation of its <t> runs. */
function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    unescapeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
  );
}

/** Cell values of one sheet row, keyed by column letter ("" for empty cells). */
function rowCells(sheet: string, row: number, strings: string[]): Record<string, string> {
  const rowXml = sheet.match(new RegExp(`<row r="${row}"[^>]*>([\\s\\S]*?)</row>`))?.[1] ?? "";
  const cells: Record<string, string> = {};
  for (const m of rowXml.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const v = m[3]?.match(/<v>([\s\S]*?)<\/v>/)?.[1];
    cells[m[1]] = v === undefined ? "" : /t="s"/.test(m[2]) ? strings[Number(v)] : v;
  }
  return cells;
}

describe("hosted spreadsheet fields", () => {
  it("every cell in rows 6-26, columns C-O, equals DCTE_ROWS", () => {
    const zip = readFileSync(FILE);
    const strings = sharedStrings(readZipEntry(zip, "xl/sharedStrings.xml"));
    const sheet = readZipEntry(zip, "xl/worksheets/sheet1.xml");
    const isoDate = (s: string) => {
      const [m, d, y] = s.split("/").map(Number);
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    };

    DCTE_ROWS.forEach((r, i) => {
      const c = rowCells(sheet, 6 + i, strings);
      expect(
        {
          beneficiary: c.C,
          city: c.D,
          county: c.E,
          address: c.F,
          termYears: c.G,
          rate: Number(c.H),
          jobsCreated: Number(c.I),
          jobsCreatedPayroll: Number(c.J),
          jobsRetained: Number(c.K),
          jobsRetainedPayroll: Number(c.L),
          committedInvestment: Number(c.M),
          estimatedAward: Number(c.N),
          approvalDate: isoDate(c.O),
        },
        `sheet row ${6 + i}`,
      ).toEqual({
        beneficiary: r.beneficiary,
        city: r.city,
        county: r.county,
        address: r.address,
        termYears: r.termYears,
        rate: r.rate,
        jobsCreated: r.jobsCreated,
        jobsCreatedPayroll: r.jobsCreatedPayroll,
        jobsRetained: r.jobsRetained,
        jobsRetainedPayroll: r.jobsRetainedPayroll,
        committedInvestment: r.committedInvestment,
        estimatedAward: r.estimatedAward,
        approvalDate: r.approvalDate,
      });
    });
  });
});

describe("hosted spreadsheet totals", () => {
  it("DCTE_ROWS agree with the sheet's own Total (N27) and Count (C28) rows", () => {
    const zip = readFileSync(FILE);
    const strings = sharedStrings(readZipEntry(zip, "xl/sharedStrings.xml"));
    const sheet = readZipEntry(zip, "xl/worksheets/sheet1.xml");
    const total = rowCells(sheet, 27, strings);
    const count = rowCells(sheet, 28, strings);
    // Guard against reading the wrong rows: check the row labels.
    expect(total.A).toBe("Total");
    expect(total.B).toBe("Sum");
    expect(count.B).toBe("Count");
    expect(DCTE_ROWS.reduce((s, r) => s + r.estimatedAward, 0)).toBe(Number(total.N));
    expect(DCTE_ROWS).toHaveLength(Number(count.C));
    // Cross-check against the figures as read when the page was built.
    expect(Number(total.N)).toBe(595828437);
    expect(Number(count.C)).toBe(21);
  });
});
