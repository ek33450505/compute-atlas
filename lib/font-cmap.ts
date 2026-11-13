/**
 * Code points a TTF covers, read from its cmap table (formats 4 and 12 on the
 * Unicode subtables). Shared by the OG text sanitiser and its tests so both
 * use one implementation. Throws on a malformed or cmap-less font; callers
 * that must not fail catch.
 */
export function cmapCodePoints(buf: Buffer): Set<number> {
  const numTables = buf.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < numTables; i++) {
    if (buf.toString("latin1", 12 + i * 16, 16 + i * 16) === "cmap") cmap = buf.readUInt32BE(20 + i * 16);
  }
  if (cmap < 0) throw new Error("font has no cmap table");
  const set = new Set<number>();
  const n = buf.readUInt16BE(cmap + 2);
  for (let i = 0; i < n; i++) {
    const pid = buf.readUInt16BE(cmap + 4 + i * 8);
    const eid = buf.readUInt16BE(cmap + 6 + i * 8);
    if (!(pid === 0 || (pid === 3 && (eid === 1 || eid === 10)))) continue;
    const st = cmap + buf.readUInt32BE(cmap + 8 + i * 8);
    const format = buf.readUInt16BE(st);
    if (format === 4) {
      const segs = buf.readUInt16BE(st + 6) / 2;
      for (let s = 0; s < segs; s++) {
        const end = buf.readUInt16BE(st + 14 + s * 2);
        const start = buf.readUInt16BE(st + 16 + segs * 2 + s * 2);
        const delta = buf.readUInt16BE(st + 16 + segs * 4 + s * 2);
        const roAt = st + 16 + segs * 6 + s * 2;
        const ro = buf.readUInt16BE(roAt);
        for (let c = start; c <= end && c < 0xffff; c++) {
          // Glyph 0 is .notdef: a mapping to it is not coverage. With a
          // non-zero idRangeOffset, idDelta applies to a non-zero looked-up id.
          let glyph: number;
          if (ro === 0) glyph = (c + delta) & 0xffff;
          else {
            const looked = buf.readUInt16BE(roAt + ro + (c - start) * 2);
            glyph = looked === 0 ? 0 : (looked + delta) & 0xffff;
          }
          if (glyph !== 0) set.add(c);
        }
      }
    } else if (format === 12) {
      const groups = buf.readUInt32BE(st + 12);
      for (let g = 0; g < groups; g++) {
        const s = buf.readUInt32BE(st + 16 + g * 12);
        // Clamp so a crafted group cannot make this loop (and the set) huge.
        const e = Math.min(buf.readUInt32BE(st + 20 + g * 12), 0x10ffff);
        for (let c = s; c <= e; c++) set.add(c);
      }
    }
  }
  return set;
}
