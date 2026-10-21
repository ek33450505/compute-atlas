// Refresh the page cache from targets.json. Tries each source until one returns
// readable HTML.
//
// NEVER regexes a PDF's bytes (produced a phantom "93, 4" across ~10
// records) -- PDFs are skipped by extension AND by content-type.
//
// ⚠️ HEAD-TRUNCATION IS A SILENT EVIDENCE-DESTROYER. The first cut of this
// script kept text.slice(0, 20000). For the two SEC filings in the set (809k and
// 333k chars) that slice held the XBRL header and cover page: zero MW figures,
// not even the facility name. Labeling those pages against the DB's recorded
// capacity would have scored two guaranteed "misses" that were the harness's
// fault, not the model's -- the same instrument-before-model error the plan has
// now logged seven times.
//
// So: long documents are WINDOWED around mentions of the facility's distinctive
// name tokens (the PR #151 idea -- match by distinctive tokens, never the exact
// canonical string), not truncated from the head. Windows are entity-anchored,
// NOT unit-anchored: anchoring on "MW" would hand the model pre-filtered evidence
// and inflate recall. The real pipeline needs this same windowing for the same reason.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fetchGuardedBody } from "../fetch-page-text";
import { htmlToText } from "./html.mjs";

// Run under tsx (`npx tsx scripts/discovery/bench/fetch-pages.mjs`): the guarded
// fetcher is TypeScript. Sources are approved facility URLs, some contributor-
// submitted, so every fetch goes through its pinned connection, per-hop SSRF
// re-validation, content-type allowlist and byte cap -- never the global fetch.
const ATTEMPT_TIMEOUT_MS = 25000;
// A response with NO content-type header is rejected (bad_content_type); the
// old global-fetch path accepted it.
const ALLOWED_CONTENT_TYPES = ["text/html", "text/plain", "application/xhtml+xml"];
// The guarded fetcher's 2 MB default would silently drop the SEC inline-XBRL
// filings in the corpus (808,982 and 332,732 chars AFTER tag stripping, so the
// raw HTML is several times that), shrinking the corpus on --refresh. This is a
// hand-run bench, not the nightly pipeline, so a generous cap is acceptable.
const MAX_BENCH_BYTES = 32 * 1024 * 1024;
const HEAD_LIMIT = 20000;   // short docs pass through untouched
const RADIUS = 3000;        // chars kept either side of an entity mention
const MAX_WINDOWS = 12;
const TOTAL_CAP = 45000;    // ~11k tokens, well inside num_ctx 16384

const GENERIC = new Set(["data","center","centers","centre","datacenter","campus","the","of","and",
  "llc","inc","corp","corporation","company","technology","park","power","station","project","site",
  "facility","facilities","phase","north","south","east","west","county","city","town","township",
  "development","group","holdings","energy","digital","mining","american","national","proposed"]);

export function distinctiveTokens(name, city) {
  const toks = `${name} ${city || ""}`.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter((t) => t.length >= 4 && !GENERIC.has(t) && !/^\d+$/.test(t));
  return [...new Set(toks)];
}

export function windowText(text, name, city) {
  if (text.length <= HEAD_LIMIT) return { text, mode: "full", windows: 0 };
  const toks = distinctiveTokens(name, city);
  // Rank tokens by RARITY, not by order. On a 333k XBRL filing the operator token
  // ("applied") occurs throughout and localises nothing, while the site token
  // ("jamestown") pinpoints the passage that matters. Anchoring on the common
  // token merged every window into one giant span whose budget-clamped prefix was
  // pure boilerplate -- head truncation wearing a windowing costume.
  const byTok = [];
  for (const t of toks) {
    const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const idx = [];
    let m;
    while ((m = re.exec(text)) !== null && idx.length < 500) idx.push(m.index);
    if (idx.length) byTok.push({ tok: t, idx });
  }
  if (!byTok.length) return { text: text.slice(0, HEAD_LIMIT), mode: "head-fallback", windows: 0 };
  byTok.sort((a, b) => a.idx.length - b.idx.length); // rarest first
  const hits = [];
  for (const { idx } of byTok) {
    if (hits.length >= MAX_WINDOWS * 2) break;
    hits.push(...idx.slice(0, MAX_WINDOWS * 2 - hits.length));
  }
  hits.sort((a, b) => a - b);
  // merge overlapping windows
  const spans = [];
  for (const h of hits) {
    const s = Math.max(0, h - RADIUS), e = Math.min(text.length, h + RADIUS);
    const last = spans[spans.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else spans.push([s, e]);
    if (spans.length > MAX_WINDOWS * 3) break;
  }
  const kept = [];
  let total = 0;
  for (const [s, e] of spans.slice(0, MAX_WINDOWS)) {
    const remaining = TOTAL_CAP - total;
    if (remaining <= 0) break;
    // Merged spans can exceed the whole budget on a doc that mentions the entity
    // throughout (applied-digital-jamestown-nd merged into one 333k span). The
    // first cut of this loop `break`ed on that and emitted an EMPTY page --
    // silently handing the model zero evidence and scoring it a miss. Clamp to
    // the remaining budget instead of dropping the span.
    const chunk = text.slice(s, e).slice(0, remaining);
    kept.push(chunk); total += chunk.length;
  }
  const joined = kept.join("\n […] \n");
  if (joined.length < 400) return { text: text.slice(0, HEAD_LIMIT), mode: "head-fallback", windows: 0 };
  return { text: joined, mode: "windowed", windows: kept.length };
}

// Fetch a single target, trying each of its sources in turn. Returns the cache
// entry on success, or null if nothing usable was found (mirrors the original
// inline loop's semantics -- unchanged fetch/strip/window/fail-loud guards).
// `droppableIds` are ids whose cached page this run would LOSE if no source
// yields an entry (see fetchOptions): when such a target ends with no page after
// any source, one loud warning naming the last skip reason is printed after the
// source loop.
/**
 * @param {{ id: string, name: string, city?: string, state?: string, facilityType?: string, status?: string, truth?: unknown, sources: string[] }} t
 * @param {{ droppableIds?: Set<string> }} [options]
 * @returns {Promise<{ facilityId: string, url: string, rawLength: number, text: string, [k: string]: unknown } | null>} the cache entry, or null when no source yielded a page
 */
export async function fetchOne(t, { droppableIds = new Set() } = {}) {
  let tooLarge = false;
  let lastSkip = "no usable source";
  for (const url of t.sources) {
    if (/\.pdf(\?|$)/i.test(url)) { lastSkip = "pdf_extension"; continue; }
    try {
      const r = await fetchGuardedBody(url, { timeoutMs: ATTEMPT_TIMEOUT_MS }, { allowedContentTypes: ALLOWED_CONTENT_TYPES, maxBytes: MAX_BENCH_BYTES });
      if (!r.ok) {
        const detail = r.reason === "http_error" ? ` ${r.httpStatus}` : r.reason === "network_error" ? ` ${r.errorCode ?? ""}` : "";
        console.log(`  ${r.reason}${detail} skip  ${t.id}`);
        lastSkip = `${r.reason}${detail}`.trimEnd();
        if (r.reason === "too_large") tooLarge = true;
        continue;
      }
      // UTF-8 regardless of the header charset (r.text() used to honour it): the
      // shipped fetchPageText decodes UTF-8, and bench parity with it is the point.
      const html = r.bytes.toString("utf-8");
      // htmlToText is a hand-ported copy of fetch-page-text.ts's `htmlToText`
      // (scripts/discovery/bench/html.mjs) — script/style stripped WITH
      // contents, remaining tags stripped, then entities decoded (named +
      // decimal numeric), then whitespace collapsed. html-parity.test.ts
      // keeps the two implementations in step. The tag-stripping regex was
      // also harmonised to the shipped extractor's `/<[^>]+>/g` (one-or-more),
      // replacing this file's old inline `/<[^>]*>/g` (zero-or-more) — the two
      // disagree only on the literal input `<>`, which the old regex stripped
      // and the shipped one leaves as text. Deliberate: the point is matching
      // fetch-page-text.ts exactly, not preserving the old bench behavior.
      const full = htmlToText(html);
      if (full.length < 400) { console.log(`  thin_page skip  ${t.id} (${full.length}ch)`); lastSkip = "thin_page"; continue; }
      const w = windowText(full, t.name, t.city);
      // Fail loudly: an empty/near-empty extract must never reach the cache and
      // become a "miss" the model gets blamed for.
      if (w.text.length < 400) { console.log(`  !!! empty_extract skip  ${t.id} (raw=${full.length}) -- NOT CACHED`); lastSkip = "empty_extract"; continue; }
      const entry = { facilityId: t.id, name: t.name, city: t.city, state: t.state,
        facilityType: t.facilityType, status: t.status, url,
        rawLength: full.length, extractMode: w.mode, windows: w.windows,
        text: w.text, truth: t.truth };
      console.log(`  ok  raw=${String(full.length).padStart(7)}  kept=${String(w.text.length).padStart(6)}  ${w.mode.padEnd(13)} ${t.id}`);
      return entry;
    } catch (e) { console.log(`  ERR      ${t.id}  ${String(e.message).slice(0, 40)}`); lastSkip = "error"; }
  }
  console.log(`  >>> NO PAGE for ${t.id}`);
  if (droppableIds.has(t.id)) {
    console.log(`  !!! ${t.id} is in pages.json and --refresh will DROP it from the corpus (last: ${lastSkip})${tooLarge ? "; too_large: raise MAX_BENCH_BYTES" : ""}`);
  }
  return null;
}

// Options for fetchOne. Only --refresh rebuilds from scratch, so only there is a
// cached page lost when its refetch fails; additive mode never refetches cached
// ids and --only keeps the old entry on a failed refetch.
/**
 * @param {{ facilityId: string }[]} cachedPages
 * @param {{ refresh?: boolean }} [mode]
 * @returns {{ droppableIds: Set<string> }}
 */
export function fetchOptions(cachedPages, { refresh = false } = {}) {
  return { droppableIds: refresh ? new Set(cachedPages.map((e) => e.facilityId)) : new Set() };
}

// Which targets a run fetches: everything under --refresh, the named ids under
// --only, otherwise only targets missing from the cache (additive).
/**
 * @template {{ id: string }} T
 * @param {T[]} targets
 * @param {{ facilityId: string }[]} cachedPages
 * @param {{ refresh?: boolean, only?: Set<string> | null }} [mode] `refresh` wins over `only`
 * @returns {T[]} the targets this run fetches
 */
export function selectTargets(targets, cachedPages, { refresh = false, only = null } = {}) {
  // First occurrence of a duplicated id wins, so an id is fetched (and warned
  // about) once and never cached twice.
  const seen = new Set();
  const unique = targets.filter((t) => !seen.has(t.id) && seen.add(t.id));
  if (refresh) return unique;
  if (only) return unique.filter((t) => only.has(t.id));
  const cachedIds = new Set(cachedPages.map((e) => e.facilityId));
  return unique.filter((t) => !cachedIds.has(t.id));
}

/**
 * Every cached id --refresh drops, split by who reports it: `removed` ids are no
 * longer in targets.json (main prints their warning), `failed` ids are still
 * targets but yielded no entry (fetchOne printed their warning). `all` is the
 * union, each id once.
 * @param {{ facilityId: string }[]} cachedPages
 * @param {{ id: string }[]} targets
 * @param {{ facilityId: string }[]} fetched
 * @returns {{ removed: string[], failed: string[], all: string[] }}
 */
export function refreshDrops(cachedPages, targets, fetched) {
  const targetIds = new Set(targets.map((t) => t.id));
  const fetchedIds = new Set(fetched.map((f) => f.facilityId));
  const cached = [...new Set(cachedPages.map((e) => e.facilityId))].filter((id) => !fetchedIds.has(id));
  const removed = cached.filter((id) => !targetIds.has(id));
  const failed = cached.filter((id) => targetIds.has(id));
  return { removed, failed, all: cached };
}

/**
 * Ids that appear more than once in targets.json (selectTargets keeps the first).
 * @param {{ id: string }[]} targets
 * @returns {string[]} each duplicated id once
 */
export function duplicateIds(targets) {
  const seen = new Set();
  const dups = new Set();
  for (const t of targets) (seen.has(t.id) ? dups : seen).add(t.id);
  return [...dups];
}

const PAGES_PATH = new URL("./pages.json", import.meta.url).pathname;

/**
 * Fails closed: only a missing file means "empty cache". An unreadable or corrupt
 * pages.json must stop the run, or it would be treated as empty and overwritten.
 * @param {string} [path]
 * @returns {{ facilityId: string }[]}
 */
export function readExistingPages(path = PAGES_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw new Error(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let pages;
  try {
    pages = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path} is not valid JSON (refusing to treat it as empty and overwrite it): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(pages)) throw new Error(`${path} is valid JSON but not an array (refusing to treat it as empty and overwrite it)`);
  return pages;
}

// Symlink/space-safe entrypoint check — see scripts/is-entrypoint.ts (this script runs under tsx).
function isEntrypoint() {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
if (isEntrypoint()) {
  const targets = JSON.parse(readFileSync(new URL("./targets.json", import.meta.url).pathname, "utf8"));
  const args = process.argv.slice(2);
  const REFRESH = args.includes("--refresh");
  const onlyArg = args.find((a) => a.startsWith("--only="));
  const ONLY = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean)) : null;

  if (REFRESH) {
    console.log("\n" + "!".repeat(72));
    console.log("!!! --refresh: rebuilding the ENTIRE corpus from scratch.");
    console.log("!!! Every cached page's text may change (rewrites, link rot). Hand-");
    console.log("!!! verified labels in truth.json may no longer match the re-fetched");
    console.log("!!! text -- re-verify every affected label, do not assume it still holds.");
    console.log("!".repeat(72) + "\n");
  }

  // Re-running this script used to REPLACE pages.json wholesale with only what
  // that run fetched. That is destructive in two silent ways: (1) a page that
  // was rewritten or link-rotted since it was cached comes back with DIFFERENT
  // text, invisibly invalidating the hand-verified label still sitting in
  // truth.json for it -- the bench then scores a model against labels that no
  // longer describe the cached text; (2) a page that now fails to fetch just
  // DISAPPEARS from the corpus, silently shrinking it. So the default mode is
  // additive: only targets missing from the existing cache get fetched, and
  // every existing entry is carried through UNMODIFIED — its parsed object is
  // reused as-is, never re-fetched. (The whole file is still re-serialised on
  // write, so bytes are not literally preserved; the page `text` and labels
  // are, which is what truth.json is pinned to.)
  // --refresh opts back into the old destructive whole-corpus rebuild, and
  // --only=<id,id> repairs specific stale entries without touching the rest.
  const cachedPages = readExistingPages();
  const existing = REFRESH ? [] : cachedPages;
  const existingIds = new Set(existing.map((e) => e.facilityId));

  for (const id of duplicateIds(targets)) {
    console.log(`  !!! duplicate target id ${id} in targets.json — only the first entry is fetched`);
  }
  const toFetch = selectTargets(targets, cachedPages, { refresh: REFRESH, only: ONLY });

  const opts = fetchOptions(cachedPages, { refresh: REFRESH });
  const fetched = [];
  for (const t of toFetch) {
    const entry = await fetchOne(t, opts);
    if (entry) fetched.push(entry);
  }
  const fetchedById = new Map(fetched.map((f) => [f.facilityId, f]));
  if (REFRESH) {
    const drops = refreshDrops(cachedPages, targets, fetched);
    for (const id of drops.removed) {
      console.log(`  !!! ${id} is in pages.json but not in targets.json; --refresh will DROP it`);
    }
    if (drops.all.length) console.log(`  !!! --refresh will drop ${drops.all.length} cached page(s) (each listed above)`);
  }

  let finalOut;
  if (REFRESH) {
    finalOut = fetched;
  } else if (ONLY) {
    // Replace matching entries in place (preserving position); a failed
    // refetch of an existing id leaves the old entry untouched rather than
    // dropping it. Newly fetched ids that weren't cached before are appended.
    finalOut = existing.map((e) => fetchedById.has(e.facilityId) ? fetchedById.get(e.facilityId) : e);
    for (const f of fetched) if (!existingIds.has(f.facilityId)) finalOut.push(f);
  } else {
    finalOut = [...existing, ...fetched];
  }

  const preservedCount = existing.filter((e) => !fetchedById.has(e.facilityId)).length;
  const failedCount = toFetch.length - fetched.length;

  writeFileSync(new URL("./pages.json", import.meta.url).pathname, JSON.stringify(finalOut, null, 2));
  console.log(`\npreserved ${preservedCount} · fetched ${fetched.length}/${toFetch.length} attempted · failed ${failedCount} · total cached ${finalOut.length}/${targets.length} targets`);
}
