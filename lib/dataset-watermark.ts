import { createHmac } from "node:crypto";

/**
 * Per-grant watermark for the dataset downloads (design 7).
 *
 * Every approved grantee receives facilities.json and facilities.csv with the SAME facilities in a
 * row ORDER unique to their grant. The records themselves are untouched, so the file is
 * byte-length-identical to the edition's and nothing downstream can tell; a leaked copy is traced
 * by recomputing each grant's order and ranking how closely the leak matches it. siting-context.json
 * is NOT watermarked.
 *
 * ⛔ THE ALGORITHM IS A PUBLIC-FORMAT-GRADE CONTRACT. The trace tool recomputes the order of
 * editions shipped months ago, so any change to the seed derivation, the stream, the rejection
 * rule or the shuffle direction silently makes every old leak untraceable. The known-answer vector
 * in `dataset-watermark.test.ts` pins it; never edit that vector to make a change pass.
 *
 * Base order is "sorted by id" (the edition builder's order); JSON and CSV list the same
 * facilities in that order, so one permutation serves both and the trace tool maps either file
 * back to ids.
 *
 * Nothing in this file logs. Errors carry their code only, never the secret, ids or body.
 */

export interface WatermarkKey {
  secret: string;
  grantId: string;
  editionId: string;
}

export type WatermarkErrorCode = "watermark_no_secret" | "watermark_parse_failed";

export class WatermarkError extends Error {
  readonly code: WatermarkErrorCode;
  constructor(code: WatermarkErrorCode) {
    super(code);
    this.name = "WatermarkError";
    this.code = code;
  }
}

/**
 * seed = HMAC-SHA256(secret, `${grantId}:${editionId}`). The separator is ":" because grant and
 * edition ids are UUIDs, which contain no ":", so two different (grantId, editionId) pairs can
 * never concatenate to the same string.
 */
function seedFor(key: WatermarkKey): Buffer {
  if (!key.secret) throw new WatermarkError("watermark_no_secret");
  return createHmac("sha256", key.secret).update(`${key.grantId}:${key.editionId}`).digest();
}

const TWO_POW_32 = 2 ** 32;

/** Deterministic stream of uint32s: block k = HMAC-SHA256(seed, uint32BE(k)), read as 8 big-endian words. */
function* uint32Stream(seed: Buffer): Generator<number, never, undefined> {
  for (let counter = 0; ; counter++) {
    const ctr = Buffer.alloc(4);
    ctr.writeUInt32BE(counter, 0);
    const block = createHmac("sha256", seed).update(ctr).digest();
    for (let off = 0; off + 4 <= block.length; off += 4) yield block.readUInt32BE(off);
  }
}

/**
 * A uniform integer in [0, range) from `stream`, by rejection sampling, not `value % range` alone:
 * 2^32 is not a multiple of `range`, so a bare modulo makes the low residues slightly likelier, a
 * bias that makes the "unique order" claim weaker than it reads. Values at or above
 * `limit = floor(2^32 / range) * range` are discarded and redrawn, so every residue has exactly
 * `limit / range` preimages. Exported for the test only: a rejection is a ~range/2^32 event, so
 * no realistic known-answer vector exercises it and it needs a scripted stream.
 */
export function drawBelow(range: number, stream: Iterator<number>): number {
  const limit = Math.floor(TWO_POW_32 / range) * range;
  let value = stream.next().value as number;
  while (value >= limit) value = stream.next().value as number;
  return value % range;
}

/**
 * perm[i] = index in the base order of the record placed at position i.
 * Fisher-Yates from i = n-1 down to 1, choosing j uniformly in [0, i] via `drawBelow`.
 */
export function watermarkPermutation(n: number, key: WatermarkKey): number[] {
  const seed = seedFor(key);
  if (!Number.isInteger(n) || n < 0) throw new RangeError("n must be a non-negative integer");
  const perm = Array.from({ length: n }, (_, i) => i);
  const stream = uint32Stream(seed);
  for (let i = n - 1; i >= 1; i--) {
    const j = drawBelow(i + 1, stream);
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  return perm;
}

/**
 * `body` is the edition's facilities.json: `JSON.stringify(arr, null, 2) + "\n"`. Returns the same
 * format with the elements reordered. Byte length is identical for a body in that format.
 */
export function watermarkJsonArray(body: string, key: WatermarkKey): string {
  seedFor(key);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new WatermarkError("watermark_parse_failed");
  }
  if (!Array.isArray(parsed)) throw new WatermarkError("watermark_parse_failed");
  const perm = watermarkPermutation(parsed.length, key);
  return JSON.stringify(perm.map((src) => parsed[src]), null, 2) + "\n";
}

/**
 * Splits RFC 4180 text into records, each WITHOUT its terminating CRLF. A CRLF inside a
 * double-quoted cell is cell content, not a record break; a doubled quote toggles the quoted state
 * twice, so it needs no special case. Throws on an unterminated quote or a missing final CRLF.
 */
function splitRecords(body: string): string[] {
  const records: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') {
      quoted = !quoted;
    } else if (!quoted && ch === "\r" && body[i + 1] === "\n") {
      records.push(body.slice(start, i));
      i++;
      start = i + 1;
    }
  }
  if (quoted || start !== body.length || records.length === 0) throw new WatermarkError("watermark_parse_failed");
  return records;
}

/**
 * `body` is `facilitiesToCsv` output: CRLF after every record (the last included), first record is
 * the header and stays first. Data records are reordered by the same permutation as the JSON array.
 */
export function watermarkCsv(body: string, key: WatermarkKey): string {
  seedFor(key);
  const [header, ...rows] = splitRecords(body);
  const perm = watermarkPermutation(rows.length, key);
  return [header, ...perm.map((src) => rows[src])].map((record) => `${record}\r\n`).join("");
}
