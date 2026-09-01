// Refresh the page cache from targets.json. Tries each source until one returns
// readable HTML.
//
// NEVER regexes a PDF's bytes (s96: produced a phantom "93, 4" across ~10
// records) -- PDFs are skipped by extension AND by content-type.
//
// s97 -- ⚠️ HEAD-TRUNCATION IS A SILENT EVIDENCE-DESTROYER. The first cut of this
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
import { readFileSync, writeFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
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
async function fetchOne(t) {
  for (const url of t.sources) {
    if (/\.pdf(\?|$)/i.test(url)) continue;
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(25000) });
      if (!r.ok) { console.log(`  ${String(r.status).padStart(3)} skip  ${t.id}`); continue; }
      if (/pdf/i.test(r.headers.get("content-type") || "")) { console.log(`  pdf skip ${t.id}`); continue; }
      const html = await r.text();
      // `<\/script\b[^>]*>` not `<\/script>`: HTML parsers tolerate whitespace AND
      // stray junk inside an end tag (`</script >`, `</script\t\n bar>`). Without it, script contents survive the
      // strip and land in the cached page text as if they were prose (CodeQL
      // js/bad-tag-filter, flagged on PR #158). Mirrors SCRIPT_OR_STYLE_RE in
      // scripts/discovery/fetch-page-text.ts — keep the two in step.
      const full = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
        .replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      if (full.length < 400) { console.log(`  thin skip ${t.id} (${full.length}ch)`); continue; }
      const w = windowText(full, t.name, t.city);
      // Fail loudly: an empty/near-empty extract must never reach the cache and
      // become a "miss" the model gets blamed for.
      if (w.text.length < 400) { console.log(`  !!! EMPTY EXTRACT ${t.id} (raw=${full.length}) -- NOT CACHED`); continue; }
      const entry = { facilityId: t.id, name: t.name, city: t.city, state: t.state,
        facilityType: t.facilityType, status: t.status, url,
        rawLength: full.length, extractMode: w.mode, windows: w.windows,
        text: w.text, truth: t.truth };
      console.log(`  ok  raw=${String(full.length).padStart(7)}  kept=${String(w.text.length).padStart(6)}  ${w.mode.padEnd(13)} ${t.id}`);
      return entry;
    } catch (e) { console.log(`  ERR      ${t.id}  ${String(e.message).slice(0, 40)}`); }
  }
  console.log(`  >>> NO PAGE for ${t.id}`);
  return null;
}

function readExistingPages() {
  try {
    return JSON.parse(readFileSync(new URL("./pages.json", import.meta.url).pathname, "utf8"));
  } catch {
    return [];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
  const existing = REFRESH ? [] : readExistingPages();
  const existingIds = new Set(existing.map((e) => e.facilityId));

  let toFetch;
  if (REFRESH) toFetch = targets;
  else if (ONLY) toFetch = targets.filter((t) => ONLY.has(t.id));
  else toFetch = targets.filter((t) => !existingIds.has(t.id));

  const fetched = [];
  for (const t of toFetch) {
    const entry = await fetchOne(t);
    if (entry) fetched.push(entry);
  }
  const fetchedById = new Map(fetched.map((f) => [f.facilityId, f]));

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
