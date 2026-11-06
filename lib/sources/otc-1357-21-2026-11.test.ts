import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { OTC_1357_PROVENANCE, OTC_1357_ROWS, type OtcRow } from "./otc-1357-21-2026-11";

interface TextShow {
  readonly x: number;
  readonly y: number;
  readonly pieces: readonly string[];
}

/**
 * Text-showing operations (Tj/TJ) of a PDF with their absolute-in-the-stream
 * position, one array per page content stream in file order. Only FlateDecode
 * streams are read (node:zlib); streams that do not inflate are skipped.
 * Position tracking covers the operators these reports use: BT, Tm, Td, TD,
 * TL, T*. The coordinates are text-space values, only their ordering and
 * differences are used.
 */
function pdfTextShows(pdf: Buffer): TextShow[][] {
  const latin = pdf.toString("latin1");
  const pages: TextShow[][] = [];
  const streamRe = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(latin)) !== null) {
    const start = m.index + m[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) break;
    streamRe.lastIndex = end;
    let content: string;
    try {
      content = inflateSync(pdf.subarray(start, end)).toString("latin1");
    } catch {
      continue;
    }
    const shows: TextShow[] = [];
    let nums: number[] = [];
    let strs: string[] = [];
    let x = 0;
    let y = 0;
    let lead = 0;
    const tokenRe = /\((?:\\[\s\S]|[^\\()])*\)|\[|\]|-?[\d.]+|[A-Za-z*'"]+/g;
    for (const tm of content.matchAll(tokenRe)) {
      const tk = tm[0];
      if (/^-?[\d.]+$/.test(tk)) {
        nums.push(Number(tk));
        continue;
      }
      if (tk === "[" || tk === "]") continue;
      if (tk.startsWith("(")) {
        strs.push(unescapePdfString(tk.slice(1, -1)));
        continue;
      }
      const [n1, n2] = [nums[nums.length - 2], nums[nums.length - 1]];
      if (tk === "BT") {
        x = 0;
        y = 0;
      } else if (tk === "Tm") {
        x = n1;
        y = n2;
      } else if (tk === "Td" || tk === "TD") {
        x += n1;
        y += n2;
        if (tk === "TD") lead = -n2;
      } else if (tk === "TL") {
        lead = n2;
      } else if (tk === "T*") {
        y -= lead;
      } else if (tk === "Tj" || tk === "TJ") {
        shows.push({ x, y, pieces: strs });
      }
      nums = [];
      strs = [];
    }
    if (shows.length > 0) pages.push(shows);
  }
  return pages;
}

function unescapePdfString(s: string): string {
  return s.replace(/\\(?:([0-7]{1,3})|([\s\S]))/g, (_m, oct: string | undefined, ch: string | undefined) => {
    if (oct) return String.fromCharCode(parseInt(oct, 8));
    const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
    return map[ch as string] ?? (ch as string);
  });
}

/** Lines closer than this (text space) are wrapped lines of one row; rows sit further apart. */
const ROW_GAP = 1.2;
/**
 * x of the Entity Name, DBA Name, Mailing Address and Location Address columns
 * in the parser's text space. The mapping from the PDF's user space is affine,
 * not a plain 9x scale: parser = 112.6 + (pt - 112.6) / 9 (user-space 112.6 /
 * 247.6 / 382.6 / 576.1 become 112.6 / 127.6 / 142.6 / 164.1). The Business
 * Account ID column sits left of the first.
 */
const COLUMN_X = [112.6, 127.6, 142.6, 164.1] as const;
const COLUMN_TOLERANCE = 1;

type RowCells = readonly [string[], string[], string[], string[]];

function tokensOf(text: string): string[] {
  return norm(text).split(/\s+/).filter(Boolean);
}

function columnOf(x: number): number {
  return COLUMN_X.findIndex((cx) => Math.abs(cx - x) <= COLUMN_TOLERANCE);
}

/**
 * The PDF's own row entries: below the column-header line, shows are grouped
 * by vertical position (wrapped lines of one row are closer than ROW_GAP),
 * pages in file order, top to bottom. Within a row each string is binned by
 * its column x (the nth string of a multi-string show sits in the nth column
 * from the show's own: a multi-string TJ is assumed to be a contiguous run of
 * columns starting at the show's x. A show that skipped a blank middle column
 * would be mis-binned, which fails closed as a false mismatch; no such show
 * exists in either PDF), and a cell's tokens are read line by line, top to
 * bottom. `unplaced` counts row strings that fall in no data column, which
 * includes anything printed in the Business Account ID column.
 */
function pdfRows(pdf: Buffer): { rows: RowCells[]; unplaced: number } {
  const rows: RowCells[] = [];
  let unplaced = 0;
  for (const shows of pdfTextShows(pdf)) {
    const header = shows.find((s) => s.pieces.includes("Entity Name"));
    if (!header) continue;
    // Below the header line; the "Page N of M" footer is drawn there too on a short page.
    const body = shows.filter((s) => s.y < header.y - 5 && s.pieces[0] !== "Page");
    const ys = [...new Set(body.map((s) => s.y))].sort((a, b) => b - a);
    const groupOfY = new Map<number, number>();
    let g = -1;
    ys.forEach((yy, i) => {
      if (i === 0 || ys[i - 1] - yy > ROW_GAP) g++;
      groupOfY.set(yy, g);
    });
    for (let i = 0; i <= g; i++) {
      const lines: { y: number; col: number; toks: string[] }[] = [];
      for (const s of body.filter((sh) => groupOfY.get(sh.y) === i)) {
        const first = columnOf(s.x);
        s.pieces.forEach((piece, k) => {
          const toks = tokensOf(piece);
          if (toks.length === 0) return;
          if (first < 0 || first + k > 3) unplaced++;
          else lines.push({ y: s.y, col: first + k, toks });
        });
      }
      const cell = (c: number) =>
        lines
          .filter((l) => l.col === c)
          .sort((a, b) => b.y - a.y)
          .flatMap((l) => l.toks);
      rows.push([cell(0), cell(1), cell(2), cell(3)]);
    }
  }
  return { rows, unplaced };
}

function expectedCells(r: OtcRow): RowCells {
  return [
    tokensOf(r.entityName),
    tokensOf(r.dbaName),
    tokensOf(r.mailingAddress),
    tokensOf(r.locationAddress),
  ];
}

/** Index of the first row whose four cells differ from the PDF's, or -1; length mismatch counts. */
function firstMismatch(expected: readonly OtcRow[], pdfRowCells: readonly RowCells[]): number {
  if (expected.length !== pdfRowCells.length) return Math.min(expected.length, pdfRowCells.length);
  return expected.findIndex(
    (r, i) => JSON.stringify(expectedCells(r)) !== JSON.stringify(pdfRowCells[i]),
  );
}

/** Collapse typographic quotes so a curly/straight difference cannot fail a token. */
function norm(s: string): string {
  return s.replace(/[‘’‛′\u0091\u0092]/g, "'").replace(/[“”]/g, '"');
}

describe("otc-1357-21-2026-11 rows", () => {
  it("has unique anchors numbered per list", () => {
    for (const list of ["50", "80"] as const) {
      const rows = OTC_1357_ROWS.filter((r) => r.list === list);
      expect(rows.map((r) => r.anchor)).toEqual(rows.map((_, i) => `${list}-row-${i + 1}`));
    }
    expect(new Set(OTC_1357_ROWS.map((r) => r.anchor)).size).toBe(OTC_1357_ROWS.length);
  });
});

describe.each(OTC_1357_PROVENANCE.files)("hosted PDF $list%", (f) => {
  const path = join(process.cwd(), "public", f.filePath);
  const bytes = readFileSync(path);
  const text = norm(pdfTextShows(bytes).flatMap((p) => p.flatMap((s) => s.pieces)).join(" "));
  const { rows: pdfRowTokens, unplaced } = pdfRows(bytes);
  const mine = OTC_1357_ROWS.filter((r) => r.list === f.list);

  it("matches the pinned SHA-256 and size", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(f.sha256);
    expect(statSync(path).size).toBe(f.byteSize);
  });

  it("carries its title and generation time", () => {
    expect(text).toContain(f.title);
    // The PDF draws the label and the time as separate strings, in either order.
    expect(text).toContain("Report Generated:");
    expect(text).toContain(f.generated);
  });

  it("has as many row entries as its Total Active Accounts and the data", () => {
    const total = /Total Active Accounts:\s*(\d+)/.exec(text);
    expect(total).not.toBeNull();
    expect(Number(total![1])).toBe(f.totalActiveAccounts);
    expect(pdfRowTokens).toHaveLength(f.totalActiveAccounts);
    expect(mine).toHaveLength(f.totalActiveAccounts);
  });

  it("prints nothing in the Business Account ID column or outside the four data columns", () => {
    expect(unplaced).toBe(0);
  });

  it("prints each row's four cells, token for token in reading order, in the data's order", () => {
    expect(firstMismatch(mine, pdfRowTokens)).toBe(-1);
  });

  // The comparison itself must bite: each of these altered datasets has to be rejected.
  describe("rejects altered data", () => {
    const at = (i: number, patch: Partial<OtcRow>) =>
      mine.map((r, j) => (j === i ? { ...r, ...patch } : r));

    it("a token from another row", () => {
      expect(firstMismatch(at(1, { locationAddress: mine[1].locationAddress + " " + mine[0].dbaName.split(" ")[0] }), pdfRowTokens)).toBe(1);
    });

    it("a cell swapped between rows", () => {
      const a = mine.length - 1;
      const swapped = mine.map((r, j) =>
        j === 0 ? { ...r, locationAddress: mine[a].locationAddress } : j === a ? { ...r, locationAddress: mine[0].locationAddress } : r,
      );
      expect(firstMismatch(swapped, pdfRowTokens)).toBe(0);
    });

    it("rows out of order", () => {
      expect(firstMismatch([mine[1], mine[0], ...mine.slice(2)], pdfRowTokens)).toBe(0);
    });

    it("an entity name moved under DBA", () => {
      const i = mine.findIndex((r) => r.entityName !== "");
      if (i < 0) return; // the 50% report has no row with an entity name
      expect(
        firstMismatch(at(i, { entityName: "", dbaName: mine[i].entityName }), pdfRowTokens),
      ).toBe(i);
    });

    it("mailing and location swapped", () => {
      const i = mine.findIndex((r) => r.mailingAddress !== r.locationAddress);
      expect(
        firstMismatch(
          at(i, { mailingAddress: mine[i].locationAddress, locationAddress: mine[i].mailingAddress }),
          pdfRowTokens,
        ),
      ).toBe(i);
    });

    it("an address with its tokens reversed", () => {
      const i = mine.findIndex((r) => r.locationAddress.split(" ").length > 2);
      const reversed = mine[i].locationAddress.split(" ").reverse().join(" ");
      expect(firstMismatch(at(i, { locationAddress: reversed }), pdfRowTokens)).toBe(i);
    });

    it("a deleted row", () => {
      expect(firstMismatch(mine.slice(1), pdfRowTokens)).not.toBe(-1);
    });

    it("a fabricated address in an existing row", () => {
      expect(firstMismatch(at(0, { locationAddress: "512 NW 62ND ST TULSA OK 73118" }), pdfRowTokens)).toBe(0);
    });
  });
});
