import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_EIA861_PATH,
  ensureEia861Zip,
  loadEia861,
  readXlsxSheet,
  readZipEntry,
  type Eia861Data,
  type Eia861Provenance,
} from "./eia861";

function makeZip(entries: Record<string, string | Buffer>, method: 0 | 8 = 8): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const stored = method === 8 ? deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, stored);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + stored.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function colLetters(i: number): string {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Numeric-looking strings become <v> numbers; "" is a gap; others are shared (rich) or inline strings. */
function makeXlsx(
  sheets: { name: string; file: string; rows: string[][] }[],
  opts: { inline?: boolean; rich?: boolean } = {},
): Buffer {
  const shared: string[] = [];
  const files: Record<string, string> = {};
  sheets.forEach((s) => {
    const rowsXml = s.rows
      .map((row, r) => {
        const cells = row
          .map((v, c) => {
            if (v === "") return "";
            const ref = `${colLetters(c)}${r + 1}`;
            if (/^\d+$/.test(v)) return `<c r="${ref}" s="1"><v>${v}</v></c>`;
            if (opts.inline) return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
            shared.push(v);
            return `<c r="${ref}" s="4" t="s"><v>${shared.length - 1}</v></c>`;
          })
          .join("");
        return `<row r="${r + 1}" spans="1:9">${cells}</row>`;
      })
      .join("");
    files[`xl/worksheets/${s.file}`] = `<worksheet><sheetData>${rowsXml}</sheetData></worksheet>`;
  });
  const si = shared
    .map((v) => {
      if (!opts.rich || v.length < 2) return `<si><t>${esc(v)}</t></si>`;
      const half = Math.floor(v.length / 2);
      return `<si><r><rPr><b/></rPr><t xml:space="preserve">${esc(v.slice(0, half))}</t></r><r><t>${esc(v.slice(half))}</t></r></si>`;
    })
    .join("");
  files["xl/sharedStrings.xml"] = `<sst count="${shared.length}">${si}</sst>`;
  files["xl/workbook.xml"] =
    `<workbook><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`;
  files["xl/_rels/workbook.xml.rels"] =
    `<Relationships>${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/${s.file}"/>`).join("")}</Relationships>`;
  return makeZip(files);
}

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const provFor = (zip: Buffer, year = 2025): Eia861Provenance => ({
  year,
  url: "https://example.test/f8612025.zip",
  pageUrl: "https://example.test/",
  released: "2026-01-01",
  sha256: sha(zip),
  byteSize: zip.length,
});

describe("readZipEntry", () => {
  it.each([0, 8] as const)("reads stored/deflated entries (method %i)", (method) => {
    const zip = makeZip({ "a.txt": "hello", "dir/b.bin": Buffer.from([1, 2, 3, 0, 255]) }, method);
    expect(readZipEntry(zip, "a.txt").toString()).toBe("hello");
    expect([...readZipEntry(zip, "dir/b.bin")]).toEqual([1, 2, 3, 0, 255]);
  });

  it("throws when an entry overruns the file or its local header is past the end", () => {
    const zip = makeZip({ "a.txt": "hello" }, 0);
    const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const big = Buffer.from(zip);
    big.writeUInt32LE(1_000_000, cd + 20);
    expect(() => readZipEntry(big, "a.txt")).toThrow(/overruns the file/);
    const far = Buffer.from(zip);
    far.writeUInt32LE(zip.length - 5, cd + 42);
    expect(() => readZipEntry(far, "a.txt")).toThrow(/past the end/);
  });

  it("rejects an EOCD entry count of 0xFFFF as ZIP64", () => {
    const zip = Buffer.from(makeZip({ "a.txt": "x" }));
    zip.writeUInt16LE(0xffff, zip.length - 22 + 10);
    expect(() => readZipEntry(zip, "a.txt")).toThrow(/ZIP64/);
  });

  it("throws for a missing entry", () => {
    expect(() => readZipEntry(makeZip({ "a.txt": "x" }), "nope.txt")).toThrow("nope.txt not found in zip");
  });
});

const cellsXml = (cells: string): string => `<worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`;

/** A one-sheet ("S") workbook from hand-written XML; defaults give a valid workbook. */
function rawXlsx(o: { workbook?: string; rels?: string; ss?: string; sheets: Record<string, string> }): Buffer {
  const files: Record<string, string> = {
    "xl/workbook.xml": o.workbook ?? `<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": o.rels ?? `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
  };
  if (o.ss) files["xl/sharedStrings.xml"] = o.ss;
  for (const [name, xml] of Object.entries(o.sheets)) files[`xl/worksheets/${name}`] = xml;
  return makeZip(files);
}

describe("readXlsxSheet", () => {
  it("resolves sheets by name through r:id and Target, not by workbook order or rIdN -> sheetN", () => {
    const xlsx = rawXlsx({
      workbook: `<workbook><sheets><sheet name="Territories" sheetId="1" r:id="rId1"/><sheet name="States" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      rels: `<Relationships><Relationship Id="rId2" Target="worksheets/sheet1.xml"/><Relationship Id="rId1" Target="worksheets/sheet2.xml"/></Relationships>`,
      sheets: {
        "sheet1.xml": cellsXml(`<c r="A1" t="inlineStr"><is><t>STATES</t></is></c>`),
        "sheet2.xml": cellsXml(`<c r="A1" t="inlineStr"><is><t>TERR</t></is></c>`),
      },
    });
    expect(readXlsxSheet(xlsx, "States")[0].cells).toEqual(["STATES"]);
    expect(readXlsxSheet(xlsx, "Territories")[0].cells).toEqual(["TERR"]);
    expect(() => readXlsxSheet(xlsx, "Nope")).toThrow(/Territories, States/);
  });

  it("throws on a duplicate relationship Id", () => {
    const xlsx = rawXlsx({
      rels: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId1" Target="worksheets/other.xml"/></Relationships>`,
      sheets: { "sheet1.xml": cellsXml("") },
    });
    expect(() => readXlsxSheet(xlsx, "S")).toThrow(/duplicate relationship Id "rId1"/);
  });

  it("throws on a duplicate relationship Id even when it is not the sheet's own", () => {
    const xlsx = rawXlsx({
      rels: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId7" Target="a.xml"/><Relationship Id="rId7" Target="b.xml"/></Relationships>`,
      sheets: { "sheet1.xml": cellsXml("") },
    });
    expect(() => readXlsxSheet(xlsx, "S")).toThrow(/duplicate relationship Id "rId7"/);
  });

  it("throws on a shared-string cell with no <v>", () => {
    const xlsx = rawXlsx({ ss: `<sst><si><t>only</t></si></sst>`, sheets: { "sheet1.xml": cellsXml(`<c r="A1" t="s"/>`) } });
    expect(() => readXlsxSheet(xlsx, "S")).toThrow(/bad shared-string index/);
  });

  it("throws for a sheet without r:id or whose relationship cannot be resolved", () => {
    const sheets = { "sheet1.xml": cellsXml("") };
    const noRid = rawXlsx({
      workbook: `<workbook><sheets><sheet name="S" sheetId="1"/></sheets></workbook>`,
      rels: `<Relationships><Relationship Target="worksheets/sheet1.xml"/></Relationships>`,
      sheets,
    });
    expect(() => readXlsxSheet(noRid, "S")).toThrow(/no r:id/);
    const noMatch = rawXlsx({
      workbook: `<workbook><sheets><sheet name="S" sheetId="1" r:id="rId9"/></sheets></workbook>`,
      rels: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      sheets,
    });
    expect(() => readXlsxSheet(noMatch, "S")).toThrow(/no relationship target/);
  });

  it("throws on a bad shared-string index instead of returning a blank", () => {
    for (const v of ["99", "abc"]) {
      const xlsx = rawXlsx({ ss: `<sst><si><t>only</t></si></sst>`, sheets: { "sheet1.xml": cellsXml(`<c r="A1" t="s"><v>${v}</v></c>`) } });
      expect(() => readXlsxSheet(xlsx, "S")).toThrow(/bad shared-string index/);
    }
  });

  it("throws on a <row> or <c> without an r attribute", () => {
    const noRow = rawXlsx({ sheets: { "sheet1.xml": `<worksheet><sheetData><row><c r="A1"><v>1</v></c></row></sheetData></worksheet>` } });
    expect(() => readXlsxSheet(noRow, "S")).toThrow(/<row> without a valid r/);
    const noCell = rawXlsx({ sheets: { "sheet1.xml": cellsXml(`<c><v>1</v></c>`) } });
    expect(() => readXlsxSheet(noCell, "S")).toThrow(/<c> without a valid r/);
  });

  it("decodes entities in one pass (a decoded character is never re-scanned)", () => {
    const xlsx = rawXlsx({ sheets: { "sheet1.xml": cellsXml(`<c r="A1" t="inlineStr"><is><t>&#38;lt; &amp;amp; &lt;</t></is></c>`) } });
    expect(readXlsxSheet(xlsx, "S")[0].cells).toEqual(["&lt; &amp; <"]);
  });

  it("decodes shared strings (rich text), numbers, entities and gaps", () => {
    const xlsx = makeXlsx(
      [{ name: "S", file: "sheet1.xml", rows: [["Pacific Gas & Electric Co.", "", "4110", "<x>"]] }],
      { rich: true },
    );
    const [row] = readXlsxSheet(xlsx, "S");
    expect(row.rowNumber).toBe(1);
    expect(row.cells).toEqual(["Pacific Gas & Electric Co.", "", "4110", "<x>"]);
  });

  it("reads inline strings and numeric character references", () => {
    const xlsx = makeXlsx([{ name: "S", file: "sheet1.xml", rows: [["Café", "7"]] }], { inline: true });
    expect(readXlsxSheet(xlsx, "S")[0].cells).toEqual(["Café", "7"]);
    const ref = makeZip({
      "xl/workbook.xml": `<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="3"><c r="AA3" t="inlineStr"><is><t>&#65;&#x42;&amp;lt;</t></is></c><c r="B3"/></row></sheetData></worksheet>`,
    });
    const [row] = readXlsxSheet(ref, "S");
    expect(row.rowNumber).toBe(3);
    expect(row.cells[26]).toBe("AB&lt;");
    expect(row.cells[0]).toBe("");
    expect(row.cells[1]).toBe("");
  });
});

type Rows = string[][];
function fixtureZip(over: { sales?: Rows; utility?: Rows; territory?: Rows; territoryStates?: Rows; delivery?: Rows } = {}): Buffer {
  // Columns deliberately in a different order from the real files.
  const utilityHeader = ["State", "Extra", "Utility Name", "Utility Number"];
  const utility: Rows = over.utility ?? [
    ["Group banner"],
    utilityHeader,
    ["IL", "x", "Commonwealth Edison Co", "4110"],
    ["XX", "x", "Withheld", "88888"],
    ["MS", "x", "City of Aberdeen", "55"],
    ["MS", "x", "Duplicate Name", "55"],
  ];
  const utilityTerr: Rows = [["b"], utilityHeader, ["PR", "x", "Puerto Rico Power", "7"]];
  const terrHeader = ["County", "Utility Name", "Utility Number", "State"];
  const territory: Rows = over.territoryStates ?? [terrHeader, ["Monroe", "City of Aberdeen", "55", "MS"]];
  const territoryT: Rows = over.territory ?? [terrHeader, ["Guam", "Guam Power", "9", "GU"]];
  const salesHeader = ["BA Code", "State", "Utility Number", "Service Type", "Data Type\nO = Observed\nI = Imputed", " Part "];
  const sales: Rows = over.sales ?? [
    ["Banner"],
    ["Banner 2"],
    salesHeader,
    ["TVA", "MS", "55", "Bundled", "O", "A"],
    ["", "", "88888", "", "", ""],
    ["", "", "", "", "", ""],
    ["Footnote text with an empty utility number"],
  ];
  const salesT: Rows = [["b"], ["b"], salesHeader, ["PR", "PR", "7", "Bundled", "O", "A"]];
  const delivery: Rows = over.delivery ?? [["b"], ["b"], salesHeader, ["ERCO", "TX", "44372", "Delivery", "O", "C"]];
  return makeZip({
    "Utility_Data_2025.xlsx": makeXlsx([
      { name: "Territories", file: "sheet1.xml", rows: utilityTerr },
      { name: "States", file: "sheet2.xml", rows: utility },
    ]),
    "Service_Territory_2025.xlsx": makeXlsx([
      { name: "Counties_States", file: "sheet1.xml", rows: territory },
      { name: "Counties_Territories", file: "sheet2.xml", rows: territoryT },
    ]),
    "Sales_Ult_Cust_2025.xlsx": makeXlsx([
      { name: "States", file: "sheet1.xml", rows: sales },
      { name: "Territories", file: "sheet2.xml", rows: salesT },
    ]),
    "Delivery_Companies_2025.xlsx": makeXlsx([{ name: "Delivery Companies", file: "sheet1.xml", rows: delivery }]),
  });
}

describe("loadEia861", () => {
  it("finds columns by header text, skips banners, footnotes and 88888", () => {
    const zip = fixtureZip();
    const d = loadEia861(zip, provFor(zip));
    expect([...d.utilities.values()]).toEqual([
      { id: 4110, name: "Commonwealth Edison Co", state: "IL" },
      { id: 55, name: "City of Aberdeen", state: "MS" }, // first row wins
      { id: 7, name: "Puerto Rico Power", state: "PR" },
    ]);
    expect(d.territory).toEqual([
      { id: 55, name: "City of Aberdeen", state: "MS", county: "Monroe" },
      { id: 9, name: "Guam Power", state: "GU", county: "Guam" },
    ]);
    expect(d.salesBa).toEqual([
      { id: 55, state: "MS", part: "A", serviceType: "Bundled", baCode: "TVA" },
      { id: 7, state: "PR", part: "A", serviceType: "Bundled", baCode: "PR" },
      { id: 44372, state: "TX", part: "C", serviceType: "Delivery", baCode: "ERCO" },
    ]);
  });

  it("throws on a non-integer Utility Number, naming sheet and row", () => {
    const zip = fixtureZip({ utility: [["b"], ["State", "Utility Name", "Utility Number"], ["IL", "X", "abc"]] });
    expect(() => loadEia861(zip, provFor(zip))).toThrow(/"States" row 3/);
  });

  it("throws when a required header appears twice in the header row", () => {
    const zip = fixtureZip({ utility: [["b"], ["State", "Utility Name", "Utility Number", "State"], ["IL", "X", "5"]] });
    expect(() => loadEia861(zip, provFor(zip))).toThrow(/"State" appears more than once/);
  });

  it("throws on a missing header", () => {
    const zip = fixtureZip({ territoryStates: [["County", "Utility Name", "Utility Number"], ["Monroe", "A", "55"]] });
    expect(() => loadEia861(zip, provFor(zip))).toThrow(/Counties_States/);
  });

  it("throws when a sheet has no data rows", () => {
    const zip = fixtureZip({ territory: [["County", "Utility Name", "Utility Number", "State"]] });
    expect(() => loadEia861(zip, provFor(zip))).toThrow(/Counties_Territories.*no data rows/);
  });

  it("throws when Delivery_Companies has no data rows", () => {
    const zip = fixtureZip({ delivery: [["b"], ["b"], ["BA Code", "State", "Utility Number", "Service Type", "Part"]] });
    expect(() => loadEia861(zip, provFor(zip))).toThrow(/Delivery Companies.*no data rows/);
  });

  it("throws on a size or sha mismatch", () => {
    const zip = fixtureZip();
    expect(() => loadEia861(zip, { ...provFor(zip), byteSize: zip.length + 1 })).toThrow(/does not match the pinned 2025/);
    expect(() => loadEia861(zip, { ...provFor(zip), sha256: "0".repeat(64) })).toThrow(/does not match the pinned 2025/);
  });
});

describe("ensureEia861Zip", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = mkdtempSync(path.join(os.tmpdir(), "eia861-"));
    dirs.push(d);
    return d;
  };

  it("returns an existing good file without fetching", async () => {
    const zip = fixtureZip();
    const file = path.join(tmp(), "z.zip");
    writeFileSync(file, zip);
    const fetchImpl = vi.fn();
    const out = await ensureEia861Zip(file, { provenance: provFor(zip), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.equals(zip)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an existing file that does not match, telling the maintainer to delete it", async () => {
    const zip = fixtureZip();
    const file = path.join(tmp(), "z.zip");
    writeFileSync(file, Buffer.concat([zip, Buffer.from("x")]));
    await expect(ensureEia861Zip(file, { provenance: provFor(zip) })).rejects.toThrow(/delete .* to re-download/);
  });

  it("downloads a missing file, verifies it, and writes it into a new directory", async () => {
    const zip = fixtureZip();
    const file = path.join(tmp(), "nested", "z.zip");
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(zip), { status: 200 }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const out = await ensureEia861Zip(file, { provenance: provFor(zip), fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out.equals(zip)).toBe(true);
    expect(readFileSync(file).equals(zip)).toBe(true);
    expect(readdirSync(path.dirname(file))).toEqual(["z.zip"]); // no tmp leftovers
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws on mismatching bytes and leaves no file", async () => {
    const zip = fixtureZip();
    const dir = tmp();
    const file = path.join(dir, "z.zip");
    const fetchImpl = async () => new Response(new Uint8Array(Buffer.from("tampered")), { status: 200 });
    await expect(
      ensureEia861Zip(file, { provenance: provFor(zip), fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/does not match the pinned/);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("throws on a non-2xx response", async () => {
    const zip = fixtureZip();
    const file = path.join(tmp(), "z.zip");
    const fetchImpl = async () => new Response("no", { status: 503 });
    await expect(
      ensureEia861Zip(file, { provenance: provFor(zip), fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/503/);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(path.dirname(file))).toEqual([]);
  });
});

const REAL = path.join(process.cwd(), DEFAULT_EIA861_PATH);

describe.skipIf(!existsSync(REAL))("real EIA-861 2025 file", () => {
  let data: Eia861Data;
  beforeAll(() => {
    data = loadEia861(readFileSync(REAL));
  });

  it("has the measured table sizes", () => {
    // Raw data rows (independent Python parse): Utility_Data 1716 distinct ids in "States" (incl. the
    // Withheld id 88888) + 5 in "Territories" = 1721, minus 88888 = 1720.
    expect(data.utilities.size).toBe(1720);
    // Service_Territory: 11803 + 90 raw rows, none are 88888, so no rows dropped.
    expect(data.territory.length).toBe(11893);
    // Sales_Ult_Cust: 2869 + 11 = 2880 numeric-id rows, minus 3 rows of 88888 = 2877, plus the 7 rows of
    // Delivery_Companies (Texas delivery-only utilities that have no Sales_Ult_Cust rows) = 2884.
    expect(data.salesBa.length).toBe(2884);
  });

  it("has known spot rows", () => {
    expect(data.utilities.has(88888)).toBe(false);
    expect(data.utilities.get(4110)).toEqual({ id: 4110, name: "Commonwealth Edison Co", state: "IL" });
    expect(data.territory).toContainEqual(expect.objectContaining({ id: 55, state: "MS", county: "Monroe" }));
    expect(data.salesBa).toContainEqual(expect.objectContaining({ id: 55, state: "MS", baCode: "TVA" }));
    expect(data.salesBa).toContainEqual(expect.objectContaining({ id: 44372, state: "TX", serviceType: "Delivery", baCode: "ERCO" }));
  });
});
