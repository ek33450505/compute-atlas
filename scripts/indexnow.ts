/**
 * IndexNow submitter — an EXPLICIT MAINTAINER COMMAND.
 *
 * IndexNow is a push protocol: we host a key file at `/<key>.txt`, then POST a
 * list of changed URLs, and participating engines fetch them promptly instead
 * of waiting to crawl. The participants are **Bing, Yandex and Seznam**.
 * **Google does not participate in IndexNow** — nothing here affects Googlebot,
 * Google's index, or anything in Search Console.
 *
 * Why it exists: a data wave can add hundreds of URLs at once (the 2026-09-15
 * wave added 221), and until now there was no push path for any of them —
 * discovery was left entirely to crawl scheduling.
 *
 * ## Posture: dry run by default, `--submit` is the deliberate act
 *
 * This mirrors `db:sync`, where the dry run is the default and `--apply` is the
 * explicit act, and its `--skip-notify` sibling: "is this worth announcing" is a
 * judgement a person makes, never a heuristic and never a side effect of
 * publishing. So this script is deliberately NOT wired into `db:sync`,
 * `build:mapdata`, a GitHub Action, launchd, or any post-publish path. Run it by
 * hand, or not at all. Do not "improve" it into an automatic hook.
 *
 * ## ⚠️ A 2xx is NOT an effect
 *
 * IndexNow answers 200/202 readily. That is an acknowledgement that the request
 * parsed and the key checked out — it is NOT evidence that any URL was accepted,
 * fetched, or indexed. This project has been burned by exactly this shape
 * before: Cloudflare's `purge_cache` returns `success: true` and evicts nothing.
 * Nothing in this file (log line, comment, or doc) may treat a 2xx as
 * confirmation. Acceptance is visible in ONE place: Bing Webmaster Tools' URL
 * submission report.
 *
 * ## ⚠️ Verification is currently BLOCKED
 *
 * The Bing Webmaster Tools property for compute-atlas.com does not exist yet
 * (plan item S-2, owner: Ed, deliberately held). BWT is the only surface that
 * shows whether a submission was accepted, so this ships BUILT BUT UNVERIFIED BY
 * EFFECT. What is verified: the payload shape, the chunking, the dry-run
 * default, and that a non-2xx is surfaced rather than swallowed — all under
 * mocked network. What is NOT verified, and cannot be until S-2 lands: that a
 * real submission does anything at all. Check the first real submission in BWT
 * once that property exists, and do not describe this as working until you have.
 *
 * ## ⚠️ The key file must be DEPLOYED first
 *
 * A submission is only accepted if `${KEY_LOCATION}` is
 * reachable — the engine fetches it to prove we control the host. `public/` is
 * served from the built app, so the key file goes live on the next PRODUCTION
 * DEPLOY and not before. A submission made before that deploy will fail no
 * matter how well-formed it is. Note also that `vercel.json`'s Ignored Build
 * Step skips builds whose diff touches only `data/`, `docs/`, `.github/` or
 * `*.md`; this file and the key file are none of those, so the commit carrying
 * them does trigger a build.
 *
 * Usage:
 *   npm run indexnow                       # dry run, URLs from the live sitemap
 *   npm run indexnow -- <url> [<url>...]   # dry run, explicit URLs (paths OK)
 *   npm run indexnow -- --limit=25         # dry run, first 25 URLs only
 *   npm run indexnow -- --json             # dry run, dump the full payload JSON
 *   npm run indexnow -- --submit <url>     # actually POST the given URL
 *   npm run indexnow -- --submit           # actually POST the whole sitemap
 */

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/**
 * The IndexNow key. Public by design — it is served verbatim at
 * `${KEY_LOCATION}` and committing it is correct, not a leak: the key proves
 * host control by being fetchable there, so a secret one could not work.
 *
 * Generated 2026-09-15, 48 hex chars (the spec allows 8–128 of `[a-zA-Z0-9-]`).
 * ⚠️ Rotating it means writing the new `public/<key>.txt` AND deleting the old
 * one; `indexnow.test.ts` asserts the file exists and matches this constant, so
 * changing one without the other turns the suite red rather than failing at
 * submit time.
 */
export const INDEXNOW_KEY = "1642d47349df0226c278a57f739756ea7914b1286ac5ba90";

export const HOST = "www.compute-atlas.com";
export const ORIGIN = `https://${HOST}`;
export const KEY_LOCATION = `${ORIGIN}/${INDEXNOW_KEY}.txt`;
export const SITEMAP_URL = `${ORIGIN}/sitemap.xml`;

/** IndexNow's documented per-request ceiling. Lists longer than this are chunked. */
export const MAX_URLS_PER_REQUEST = 10_000;

export interface IndexNowPayload {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
}

export interface CliOptions {
  /** POST for real. Default false — see the posture note in the file header. */
  submit: boolean;
  /** Print the complete payload JSON instead of a readable summary. */
  json: boolean;
  /** Cap the URL list, for inspecting a payload without dumping thousands. */
  limit?: number;
  /** Explicit URLs from argv. Empty means "read the live sitemap". */
  urls: string[];
}

const KNOWN_FLAGS = new Set(["--submit", "--dry-run", "--json"]);

/**
 * `--dry-run` is accepted but redundant; it makes the default explicit at a call
 * site. Unlike `db:sync`'s equivalent, there is no "--submit always wins" case
 * to document — passing both is rejected below, because on a command whose only
 * outward-facing act is irreversible, a contradictory invocation is far more
 * likely to be a mistake than an intent.
 */
export function parseCliArgs(argv: string[]): CliOptions {
  const flags = argv.filter((arg) => arg.startsWith("-"));
  const unknown = flags.filter(
    (flag) => !KNOWN_FLAGS.has(flag) && !flag.startsWith("--limit=")
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown argument(s): ${unknown.join(", ")}. Known flags: ${[...KNOWN_FLAGS].join(", ")}, --limit=N`
    );
  }
  if (argv.includes("--submit") && argv.includes("--dry-run")) {
    throw new Error("Pass --submit or --dry-run, not both.");
  }

  const limitFlag = flags.find((flag) => flag.startsWith("--limit="));
  let limit: number | undefined;
  if (limitFlag !== undefined) {
    const raw = limitFlag.slice("--limit=".length);
    limit = Number(raw);
    // An unparseable limit must not silently become "no limit" — that is the
    // `run.sh` ENRICHMENT_LIMIT trap, where a bad value disabled the bound
    // entirely instead of failing.
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`--limit must be a positive integer, got: ${raw || "(empty)"}`);
    }
  }

  return {
    submit: argv.includes("--submit"),
    json: argv.includes("--json"),
    limit,
    urls: argv.filter((arg) => !arg.startsWith("-")),
  };
}

/**
 * Resolves one CLI argument to an absolute URL on our host.
 *
 * A bare path (`/table`) is resolved against ORIGIN for convenience. A full URL
 * must be on HOST: IndexNow requires every URL in a request to belong to the
 * declared `host`, and a foreign URL would invalidate the whole batch rather
 * than just itself — so this rejects loudly instead of filtering silently.
 */
export function normalizeUrl(input: string): string {
  const candidate = input.startsWith("/") ? `${ORIGIN}${input}` : input;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Not a valid URL or absolute path: ${input}`);
  }
  if (parsed.host !== HOST) {
    throw new Error(
      `URL is not on ${HOST} (IndexNow rejects the whole batch for one foreign URL): ${input}`
    );
  }
  return parsed.toString();
}

/** Splits into request-sized batches. `size` is a parameter only so tests can use a small one. */
export function chunkUrls(urls: string[], size: number = MAX_URLS_PER_REQUEST): string[][] {
  if (size < 1) throw new Error(`Chunk size must be at least 1, got ${size}`);
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += size) {
    chunks.push(urls.slice(i, i + size));
  }
  return chunks;
}

export function buildPayload(urls: string[]): IndexNowPayload {
  return { host: HOST, key: INDEXNOW_KEY, keyLocation: KEY_LOCATION, urlList: urls };
}

/**
 * Reads the URL list from the live sitemap rather than rebuilding it here.
 *
 * `app/sitemap.ts` is a Neon-backed dynamic route with its own deliberate
 * submission rules (single-facility operator and county hubs are omitted —
 * see MIN_FACILITIES_FOR_OPERATOR_SITEMAP). Re-deriving that here would create a
 * second definition of "which URLs do we submit" that could silently drift from
 * the first. Fetching the rendered sitemap means there is exactly one.
 *
 * Consequence worth stating: this reads PRODUCTION. URLs appear here only once
 * prod serves them (the sitemap's own ISR timer is 3600s), which is the same
 * constraint as the key file — you cannot announce a URL that does not exist yet.
 */
export async function collectSitemapUrls(sitemapUrl: string = SITEMAP_URL): Promise<string[]> {
  const response = await fetch(sitemapUrl, { headers: { accept: "application/xml" } });
  if (!response.ok) {
    throw new Error(`Sitemap fetch failed: ${response.status} ${response.statusText} (${sitemapUrl})`);
  }
  const xml = await response.text();
  // A sitemap INDEX also has <loc> entries — but they point at child sitemaps,
  // not at pages, so parsing one here would silently announce a handful of
  // .xml URLs and nothing else. This is a <urlset> today only because
  // `app/sitemap.ts` has no `generateSitemaps()`; Next switches to an index
  // the moment it gains one, which is a change nobody would think to make
  // here. Fail loudly at that boundary instead of submitting nonsense.
  if (/<sitemapindex[\s>]/i.test(xml)) {
    throw new Error(
      `${sitemapUrl} is a sitemap INDEX, not a <urlset> — app/sitemap.ts has gained ` +
        "generateSitemaps(). Its <loc> entries are child sitemap URLs, not page URLs. " +
        "Fetch each child sitemap and concatenate their URLs before submitting."
    );
  }
  const locs = [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/g)].map((m) => decodeXml(m[1].trim()));
  if (locs.length === 0) {
    throw new Error(`No <loc> entries found in ${sitemapUrl} — refusing to submit an empty list.`);
  }
  return locs.map(normalizeUrl);
}

/** The five predefined XML entities. `&amp;` is unescaped last so `&amp;lt;` survives as `&lt;`. */
function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * POSTs one batch. Throws on a non-2xx, including the response body, so a
 * rejection surfaces instead of being swallowed — `main` does not catch this.
 *
 * It does NOT return anything resembling a success signal, on purpose: the only
 * thing a 2xx establishes is that the request was well-formed and the key
 * checked out. See the header's "a 2xx is NOT an effect".
 */
export async function submitBatch(payload: IndexNowPayload): Promise<number> {
  const response = await fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(
      `IndexNow returned ${response.status} ${response.statusText}${body ? `: ${body}` : ""}`
    );
  }
  return response.status;
}

function printPayload(payload: IndexNowPayload, options: CliOptions, index: number, total: number): void {
  const label = total > 1 ? ` (batch ${index + 1} of ${total})` : "";
  // "Would POST" in a dry run, not a bare "POST" — a heading that reads as past
  // tense above a printed payload is exactly the overstatement this whole
  // script is careful about elsewhere.
  const verb = options.submit ? "POST" : "Would POST to";
  console.log(`\n${verb} ${INDEXNOW_ENDPOINT}${label}`);
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const { urlList, ...envelope } = payload;
  console.log(JSON.stringify({ ...envelope, urlList: `[${urlList.length} URLs]` }, null, 2));
  const preview = urlList.length <= 20 ? urlList : [...urlList.slice(0, 10), `  … ${urlList.length - 20} more …`, ...urlList.slice(-10)];
  for (const url of preview) console.log(`  ${url}`);
  if (urlList.length > 20) console.log("  (pass --json for the complete payload)");
}

export async function main(argv: string[]): Promise<void> {
  const options = parseCliArgs(argv);

  let urls =
    options.urls.length > 0 ? options.urls.map(normalizeUrl) : await collectSitemapUrls();
  const total = urls.length;
  if (options.limit !== undefined) urls = urls.slice(0, options.limit);

  const source = options.urls.length > 0 ? "argv" : SITEMAP_URL;
  console.log(
    `${urls.length} URL(s) from ${source}${options.limit !== undefined && total > urls.length ? ` (limited from ${total})` : ""}`
  );

  const batches = chunkUrls(urls);
  for (const [i, batch] of batches.entries()) {
    printPayload(buildPayload(batch), options, i, batches.length);
  }

  if (!options.submit) {
    console.log("\nDRY RUN — nothing was sent. Re-run with --submit to POST.");
    return;
  }

  for (const [i, batch] of batches.entries()) {
    const status = await submitBatch(buildPayload(batch));
    console.log(`Batch ${i + 1}/${batches.length}: HTTP ${status} (${batch.length} URLs)`);
  }
  console.log(
    `\nSent ${urls.length} URL(s) in ${batches.length} batch(es) to Bing/Yandex/Seznam. Google does not participate.` +
      "\nA 2xx above means the request parsed — NOT that any URL was accepted, fetched or indexed." +
      "\nAcceptance is only visible in Bing Webmaster Tools' URL submission report, which does not" +
      "\nexist for this property yet (plan item S-2). Treat this submission as unverified until it does."
  );
}

// Only run the CLI when this file is executed directly, not when its exports are
// imported by the test suite — matches scripts/sync-to-neon.ts's isMain guard.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
