/**
 * Reader for the U.S. EIA Form EIA-861 final data (a ZIP of .xlsx workbooks). EIA data is U.S.
 * government public domain.
 *
 * This module only downloads/verifies the pinned ZIP and parses three tables:
 *   - Utility_Data      -> utility id, name, home state
 *   - Service_Territory -> utility x state x county
 *   - Sales_Ult_Cust    -> utility x state x part x service type x balancing authority code
 * Matching facilities to utilities and deriving balancing authority are later units.
 *
 * Columns are located BY HEADER TEXT, never by fixed letter, and every sheet is resolved by NAME
 * through workbook.xml and its rels. The file is pinned by byte size and SHA-256; a mismatch
 * throws (or, on download, writes nothing). Only `node:` built-ins are used: the ZIP and xlsx
 * readers below are minimal and regex-based, which is enough for these well-formed EIA files.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

export type Eia861Provenance = {
  year: number;
  url: string;
  pageUrl: string;
  released: string;
  sha256: string;
  byteSize: number;
};

export const EIA861_2025 = {
  year: 2025,
  url: "https://www.eia.gov/electricity/data/eia861/zip/f8612025.zip",
  pageUrl: "https://www.eia.gov/electricity/data/eia861/",
  released: "2026-10-07",
  sha256: "f59f6c732bf685fe0a1591b32227f5ce572dc0dfd26bb5caaeed128ac4e3a396",
  byteSize: 4756816,
} as const;

export const DEFAULT_EIA861_PATH = "data/eia861/f8612025.zip"; // data/ is gitignored

/** EIA's placeholder id (name "Withheld") for withheld respondents. */
const WITHHELD_ID = 88888;

export interface Eia861Utility {
  id: number;
  name: string;
  state: string;
}
export interface Eia861TerritoryRow {
  id: number;
  name: string;
  state: string;
  county: string;
}
export interface Eia861SalesBaRow {
  id: number;
  state: string;
  part: string;
  serviceType: string;
  baCode: string;
}
export interface Eia861Data {
  provenance: Eia861Provenance;
  utilities: Map<number, Eia861Utility>;
  territory: Eia861TerritoryRow[];
  salesBa: Eia861SalesBaRow[];
}

// ---------------------------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------------------------

/** Read one entry of a ZIP via the central directory. No ZIP64, no CRC check. */
export function readZipEntry(zip: Buffer, name: string): Buffer {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: end of central directory not found");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error("ZIP64 is not supported");

  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip central directory");
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const entryName = zip.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;

    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("ZIP64 is not supported");
    }
    if (localOffset + 30 > zip.length) throw new Error(`corrupt zip: local header of ${name} is past the end`);
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > zip.length) throw new Error(`corrupt zip: ${name} overruns the file`);
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) return Buffer.from(raw);
    if (method === 8) return inflateRawSync(raw);
    throw new Error(`unsupported zip compression method ${method} for ${name}`);
  }
  throw new Error(`${name} not found in zip`);
}

// ---------------------------------------------------------------------------------------------
// xlsx
// ---------------------------------------------------------------------------------------------

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };

/** One pass, so a decoded character is never re-scanned (`&#38;lt;` stays the literal `&lt;`). `_xHHHH_` escapes are not decoded (EIA files do not use them). */
function xmlUnescape(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
    if (e[0] !== "#") return XML_ENTITIES[e];
    return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? xmlUnescape(m[1]) : undefined;
}

/** Concatenated text of every <t> in a fragment (rich-text runs, phonetic runs excluded). */
function textOf(fragment: string): string {
  const cleaned = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of cleaned.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) out += m[1] ?? "";
  return xmlUnescape(out);
}

function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function optionalEntry(zip: Buffer, name: string): Buffer | null {
  try {
    return readZipEntry(zip, name);
  } catch (err) {
    if (err instanceof Error && err.message === `${name} not found in zip`) return null;
    throw err;
  }
}

export function readXlsxSheet(xlsx: Buffer, sheetName: string): { rowNumber: number; cells: string[] }[] {
  const workbook = readZipEntry(xlsx, "xl/workbook.xml").toString("utf8");
  const rels = readZipEntry(xlsx, "xl/_rels/workbook.xml.rels").toString("utf8");

  const sheets: { name: string; rid: string | undefined }[] = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    sheets.push({ name: attr(m[1], "name") ?? "", rid: attr(m[1], "r:id") });
  }
  const sheet = sheets.find((s) => s.name === sheetName);
  if (!sheet) {
    throw new Error(`sheet "${sheetName}" not found; sheets present: ${sheets.map((s) => s.name).join(", ")}`);
  }
  if (sheet.rid === undefined) throw new Error(`sheet "${sheetName}" has no r:id`);
  let target: string | undefined;
  const seenIds = new Set<string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(m[1], "Id");
    if (id === undefined) continue;
    if (seenIds.has(id)) throw new Error(`duplicate relationship Id "${id}" in workbook.xml.rels`);
    seenIds.add(id);
    if (id === sheet.rid) target = attr(m[1], "Target");
  }
  if (!target) throw new Error(`no relationship target for sheet "${sheetName}"`);
  const sheetPath = target.startsWith("/") ? target.replace(/^\/+/, "") : `xl/${target}`;

  const shared: string[] = [];
  const ssXml = optionalEntry(xlsx, "xl/sharedStrings.xml");
  if (ssXml) {
    for (const m of ssXml.toString("utf8").matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
      shared.push(textOf(m[1] ?? ""));
    }
  }

  const xml = readZipEntry(xlsx, sheetPath).toString("utf8");
  const rows: { rowNumber: number; cells: string[] }[] = [];
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rawRow = attr(rm[1], "r");
    if (rawRow === undefined || !/^\d+$/.test(rawRow)) throw new Error(`sheet "${sheetName}": <row> without a valid r attribute`);
    const rowNumber = Number(rawRow);
    const cells: string[] = [];
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /^([A-Z]+)\d+$/.exec(attr(cm[1], "r") ?? "");
      if (!ref) throw new Error(`sheet "${sheetName}" row ${rowNumber}: <c> without a valid r attribute`);
      const col = columnIndex(ref[1]);
      const type = attr(cm[1], "t");
      const body = cm[2] ?? "";
      let value = "";
      if (type === "inlineStr") {
        value = textOf(body);
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
        if (!v && type === "s") throw new Error(`sheet "${sheetName}" row ${rowNumber}: bad shared-string index (cell has no <v>)`);
        if (v && type === "s") {
          const idx = v[1].trim();
          if (!/^\d+$/.test(idx) || Number(idx) >= shared.length) {
            throw new Error(`sheet "${sheetName}" row ${rowNumber}: bad shared-string index "${idx}"`);
          }
          value = shared[Number(idx)];
        } else if (v) {
          value = xmlUnescape(v[1]);
        }
      }
      while (cells.length < col) cells.push("");
      cells[col] = value;
    }
    rows.push({ rowNumber, cells });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// EIA-861 tables
// ---------------------------------------------------------------------------------------------

const normHeader = (s: string): string => s.trim().replace(/\s+/g, " ");

/** Rows of one sheet as header -> value, header located by text in the first 5 rows. */
function readTable(
  xlsx: Buffer,
  sheetName: string,
  required: readonly string[],
): { rowNumber: number; get: (header: string) => string }[] {
  const rows = readXlsxSheet(xlsx, sheetName);
  let headerAt = -1;
  let index = new Map<string, number>();
  for (let r = 0; r < Math.min(5, rows.length); r++) {
    const candidate = new Map<string, number>();
    const seenTwice = new Set<string>();
    rows[r].cells.forEach((c, i) => {
      const h = normHeader(c);
      if (!h) return;
      if (candidate.has(h)) seenTwice.add(h);
      else candidate.set(h, i);
    });
    if (required.every((h) => candidate.has(h))) {
      const dup = required.find((h) => seenTwice.has(h));
      if (dup) throw new Error(`sheet "${sheetName}": header "${dup}" appears more than once`);
      headerAt = r;
      index = candidate;
      break;
    }
  }
  if (headerAt < 0) {
    throw new Error(`sheet "${sheetName}": header row with ${required.join(", ")} not found in first 5 rows`);
  }

  const out: { rowNumber: number; get: (header: string) => string }[] = [];
  const idCol = index.get("Utility Number") as number;
  for (const row of rows.slice(headerAt + 1)) {
    const rawId = (row.cells[idCol] ?? "").trim();
    if (rawId === "") continue; // footnotes and blank rows
    if (!/^\d+$/.test(rawId) || Number(rawId) <= 0) {
      throw new Error(`sheet "${sheetName}" row ${row.rowNumber}: Utility Number is not a positive integer`);
    }
    if (Number(rawId) === WITHHELD_ID) continue;
    // Blank State/Name/BA Code cells stay "" (the real Sales_Ult_Cust has rows with a blank BA Code); consumers treat "" as absent.
    out.push({ rowNumber: row.rowNumber, get: (h) => (row.cells[index.get(h) as number] ?? "").trim() });
  }
  if (out.length === 0) throw new Error(`sheet "${sheetName}" yielded no data rows`);
  return out;
}

export function loadEia861(zip: Buffer, provenance: Eia861Provenance = EIA861_2025): Eia861Data {
  verifyZip(zip, provenance);
  const y = provenance.year;
  const workbook = (name: string): Buffer => readZipEntry(zip, `${name}_${y}.xlsx`);

  const utilityBook = workbook("Utility_Data");
  const utilities = new Map<number, Eia861Utility>();
  for (const sheet of ["States", "Territories"]) {
    for (const r of readTable(utilityBook, sheet, ["Utility Number", "Utility Name", "State"])) {
      const id = Number(r.get("Utility Number"));
      if (!utilities.has(id)) utilities.set(id, { id, name: r.get("Utility Name"), state: r.get("State") });
    }
  }

  const territoryBook = workbook("Service_Territory");
  const territory: Eia861TerritoryRow[] = [];
  for (const sheet of ["Counties_States", "Counties_Territories"]) {
    for (const r of readTable(territoryBook, sheet, ["Utility Number", "Utility Name", "State", "County"])) {
      territory.push({
        id: Number(r.get("Utility Number")),
        name: r.get("Utility Name"),
        state: r.get("State"),
        county: r.get("County"),
      });
    }
  }

  const salesBook = workbook("Sales_Ult_Cust");
  const salesBa: Eia861SalesBaRow[] = [];
  for (const sheet of ["States", "Territories"]) {
    for (const r of readTable(salesBook, sheet, ["Utility Number", "Part", "Service Type", "State", "BA Code"])) {
      salesBa.push({
        id: Number(r.get("Utility Number")),
        state: r.get("State"),
        part: r.get("Part"),
        serviceType: r.get("Service Type"),
        baCode: r.get("BA Code"),
      });
    }
  }

  return { provenance, utilities, territory, salesBa };
}

// ---------------------------------------------------------------------------------------------
// Download / verify
// ---------------------------------------------------------------------------------------------

function verifyZip(zip: Buffer, provenance: Eia861Provenance): void {
  const sha = createHash("sha256").update(zip).digest("hex");
  if (zip.length !== provenance.byteSize || sha !== provenance.sha256) {
    throw new Error(`EIA-861 zip does not match the pinned ${provenance.year} file (sha256 ${sha}, ${zip.length} bytes)`);
  }
}

export async function ensureEia861Zip(
  file: string,
  opts: { fetchImpl?: typeof fetch; provenance?: Eia861Provenance; timeoutMs?: number } = {},
): Promise<Buffer> {
  const provenance = opts.provenance ?? EIA861_2025;
  if (existsSync(file)) {
    const existing = readFileSync(file);
    try {
      verifyZip(existing, provenance);
    } catch (err) {
      throw new Error(`${(err as Error).message}; delete ${file} to re-download`);
    }
    return existing;
  }

  const res = await (opts.fetchImpl ?? fetch)(provenance.url, {
    headers: { "User-Agent": "compute-atlas-maintainer (+https://www.compute-atlas.com)" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
  });
  if (!res.ok) throw new Error(`EIA-861 download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  verifyZip(bytes, provenance); // before anything touches disk

  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
  console.log(`downloaded EIA-861 ${provenance.year} (${bytes.length} bytes)`);
  return bytes;
}
