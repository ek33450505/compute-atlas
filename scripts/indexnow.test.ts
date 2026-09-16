// @vitest-environment node
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";

import robots from "@/app/robots";
import nextConfig from "@/next.config";

import {
  buildPayload,
  chunkUrls,
  collectSitemapUrls,
  HOST,
  INDEXNOW_ENDPOINT,
  INDEXNOW_KEY,
  KEY_LOCATION,
  main,
  MAX_URLS_PER_REQUEST,
  normalizeUrl,
  parseCliArgs,
  submitBatch,
} from "./indexnow";

// ---------------------------------------------------------------------------
// Network discipline
// ---------------------------------------------------------------------------
// ⛔ NOTHING in this file may reach api.indexnow.org. A submission is
// outward-facing, affects third parties, and — until the Bing Webmaster Tools
// property exists (plan item S-2) — has no observable effect to check, so a
// "just to be sure" real request would buy nothing and cost a real submission.
// Every test either stubs fetch with a controlled fake or stubs it with a
// thrower, so a code path that tried to reach the network would fail loudly
// rather than silently pass off a real response.

function stubFetch(impl: (input: string, init?: RequestInit) => unknown) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

function jsonResponse(status: number, body = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => body,
  };
}

function sitemapXml(urls: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `<url><loc>${u}</loc><lastmod>2026-09-15</lastmod></url>`),
    "</urlset>",
  ].join("\n");
}

// console.log is mocked so the suite stays quiet — but the mock is KEPT rather
// than discarded, because the copy this script prints is part of what the unit
// has to get right. The 2xx caveat in particular ("the request parsed, not that
// anything was accepted") is the single most important sentence here, and with
// the output thrown away it would have been free to be deleted or reworded into
// a false claim with the suite still green. `printed()` pins its substance.
function mockConsoleLog() {
  return vi.spyOn(console, "log").mockImplementation(() => {});
}
let logSpy: ReturnType<typeof mockConsoleLog>;

/** Everything the run printed, as one string. */
const printed = () => logSpy.mock.calls.map((call) => call.join(" ")).join("\n");

beforeEach(() => {
  logSpy = mockConsoleLog();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// parseCliArgs — the dry-run default is the safety property of this script
// ---------------------------------------------------------------------------
describe("parseCliArgs", () => {
  beforeEach(() => {
    stubFetch(() => {
      throw new Error("no network calls allowed in this test file");
    });
  });

  // ⚠️ Mutation-tested 2026-09-15: making submission the default
  // (`submit: !argv.includes("--dry-run")`) turns these four red. A failing
  // version looks like `expected true to be false` on `submit`.
  it.each([
    ["no arguments", [] as string[]],
    ["an explicit URL", ["/table"]],
    ["--json", ["--json"]],
    ["--limit=5", ["--limit=5"]],
  ])("defaults to a dry run with %s", (_label, argv) => {
    expect(parseCliArgs(argv).submit).toBe(false);
  });

  it("submits only when --submit is passed", () => {
    expect(parseCliArgs(["--submit"]).submit).toBe(true);
  });

  it("accepts the redundant --dry-run", () => {
    expect(parseCliArgs(["--dry-run"]).submit).toBe(false);
  });

  it("rejects --submit and --dry-run together rather than picking one", () => {
    expect(() => parseCliArgs(["--submit", "--dry-run"])).toThrow(/not both/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseCliArgs(["--apply"])).toThrow(/Unknown argument/);
  });

  it("collects non-flag arguments as URLs", () => {
    const options = parseCliArgs(["--submit", "/table", "https://www.compute-atlas.com/map"]);
    expect(options.urls).toEqual(["/table", "https://www.compute-atlas.com/map"]);
  });

  it("parses --limit=N", () => {
    expect(parseCliArgs(["--limit=25"]).limit).toBe(25);
  });

  it("leaves limit undefined when the flag is absent", () => {
    expect(parseCliArgs([]).limit).toBeUndefined();
  });

  // An unparseable bound must not silently become "no bound" — that is the
  // shape that once disabled ENRICHMENT_LIMIT entirely in run.sh.
  it.each(["--limit=abc", "--limit=0", "--limit=-5", "--limit=2.5", "--limit="])(
    "rejects %s instead of falling back to unlimited",
    (flag) => {
      expect(() => parseCliArgs([flag])).toThrow(/positive integer/);
    }
  );
});

// ---------------------------------------------------------------------------
// normalizeUrl
// ---------------------------------------------------------------------------
describe("normalizeUrl", () => {
  it("resolves a bare path against the production origin", () => {
    expect(normalizeUrl("/facilities/stargate-abilene-tx")).toBe(
      "https://www.compute-atlas.com/facilities/stargate-abilene-tx"
    );
  });

  it("passes through a URL already on the host", () => {
    expect(normalizeUrl("https://www.compute-atlas.com/table")).toBe(
      "https://www.compute-atlas.com/table"
    );
  });

  // One foreign URL invalidates the whole IndexNow batch, so this must reject
  // loudly rather than filter silently — a silently-dropped URL would look
  // exactly like a submitted one in the printed count.
  it("rejects a URL on another host", () => {
    expect(() => normalizeUrl("https://example.com/table")).toThrow(new RegExp(HOST));
  });

  it("rejects the apex host, which is not the canonical one", () => {
    expect(() => normalizeUrl("https://compute-atlas.com/table")).toThrow(/not on/);
  });

  it("rejects a string that is neither a URL nor an absolute path", () => {
    expect(() => normalizeUrl("table")).toThrow(/not a valid url or absolute path/i);
  });
});

// ---------------------------------------------------------------------------
// buildPayload
// ---------------------------------------------------------------------------
describe("buildPayload", () => {
  it("emits exactly the four IndexNow fields", () => {
    const payload = buildPayload(["https://www.compute-atlas.com/table"]);
    expect(payload).toEqual({
      host: "www.compute-atlas.com",
      key: INDEXNOW_KEY,
      keyLocation: KEY_LOCATION,
      urlList: ["https://www.compute-atlas.com/table"],
    });
    expect(Object.keys(payload)).toEqual(["host", "key", "keyLocation", "urlList"]);
  });

  it("points keyLocation at the key file actually hosted under public/", () => {
    expect(KEY_LOCATION).toBe(`https://${HOST}/${INDEXNOW_KEY}.txt`);
  });
});

// ---------------------------------------------------------------------------
// chunkUrls — the 10,000-per-request boundary
// ---------------------------------------------------------------------------
describe("chunkUrls", () => {
  const urls = (n: number) =>
    Array.from({ length: n }, (_, i) => `https://www.compute-atlas.com/facilities/f-${i}`);

  it("keeps exactly MAX_URLS_PER_REQUEST in a single request", () => {
    const chunks = chunkUrls(urls(MAX_URLS_PER_REQUEST));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(MAX_URLS_PER_REQUEST);
  });

  // The off-by-one that matters: one URL over the ceiling must split, and the
  // first chunk must be full rather than, say, halved.
  it("splits at one URL over the ceiling", () => {
    const chunks = chunkUrls(urls(MAX_URLS_PER_REQUEST + 1));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(MAX_URLS_PER_REQUEST);
    expect(chunks[1]).toHaveLength(1);
  });

  it("loses no URLs across a split", () => {
    const input = urls(MAX_URLS_PER_REQUEST + 7);
    expect(chunkUrls(input).flat()).toEqual(input);
  });

  it("leaves a list below the ceiling in one chunk", () => {
    expect(chunkUrls(urls(2598))).toHaveLength(1);
  });

  it("returns no chunks for an empty list", () => {
    expect(chunkUrls([])).toEqual([]);
  });

  it("uses 10,000 as the documented ceiling", () => {
    expect(MAX_URLS_PER_REQUEST).toBe(10000);
  });

  // Not defensive padding: `size = 0` makes the `i += size` loop never advance,
  // so without the guard this hangs forever on a non-empty list rather than
  // failing. The guard is the difference between an error and a hung command.
  it.each([0, -1])("rejects a chunk size of %i instead of looping forever", (size) => {
    expect(() => chunkUrls(["https://www.compute-atlas.com/table"], size)).toThrow(/at least 1/);
  });
});

// ---------------------------------------------------------------------------
// collectSitemapUrls
// ---------------------------------------------------------------------------
describe("collectSitemapUrls", () => {
  it("extracts every <loc> from the sitemap", async () => {
    stubFetch(async () =>
      jsonResponse(
        200,
        sitemapXml([
          "https://www.compute-atlas.com/",
          "https://www.compute-atlas.com/table",
          "https://www.compute-atlas.com/states/texas",
        ])
      )
    );
    await expect(collectSitemapUrls("https://www.compute-atlas.com/sitemap.xml")).resolves.toEqual([
      "https://www.compute-atlas.com/",
      "https://www.compute-atlas.com/table",
      "https://www.compute-atlas.com/states/texas",
    ]);
  });

  it("decodes XML entities in a <loc>", async () => {
    stubFetch(async () =>
      jsonResponse(200, sitemapXml(["https://www.compute-atlas.com/table?a=1&amp;b=2"]))
    );
    const [url] = await collectSitemapUrls("https://www.compute-atlas.com/sitemap.xml");
    expect(url).toBe("https://www.compute-atlas.com/table?a=1&b=2");
  });

  it("throws on a non-2xx sitemap response", async () => {
    stubFetch(async () => jsonResponse(503, "upstream down"));
    await expect(
      collectSitemapUrls("https://www.compute-atlas.com/sitemap.xml")
    ).rejects.toThrow(/Sitemap fetch failed: 503/);
  });

  // A sitemap INDEX has <loc> entries too, pointing at child sitemaps rather
  // than pages — so the naive parse "succeeds" and yields a handful of .xml
  // URLs. `app/sitemap.ts` produces a <urlset> today only because it has no
  // generateSitemaps(); this asserts the boundary is a loud failure, not a
  // silently wrong submission, if that ever changes.
  it("refuses a sitemap INDEX rather than submitting child sitemap URLs", async () => {
    stubFetch(async () =>
      jsonResponse(
        200,
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
          "<sitemap><loc>https://www.compute-atlas.com/sitemap/0.xml</loc></sitemap>",
          "<sitemap><loc>https://www.compute-atlas.com/sitemap/1.xml</loc></sitemap>",
          "</sitemapindex>",
        ].join("\n")
      )
    );
    await expect(
      collectSitemapUrls("https://www.compute-atlas.com/sitemap.xml")
    ).rejects.toThrow(/sitemap INDEX/);
  });

  // A sitemap that parsed to nothing must not become a zero-URL submission
  // that looks successful — an empty urlList is a bug report, not a no-op.
  it("refuses an empty sitemap rather than submitting nothing", async () => {
    stubFetch(async () => jsonResponse(200, sitemapXml([])));
    await expect(
      collectSitemapUrls("https://www.compute-atlas.com/sitemap.xml")
    ).rejects.toThrow(/No <loc> entries/);
  });
});

// ---------------------------------------------------------------------------
// submitBatch — a non-2xx must surface, never be swallowed
// ---------------------------------------------------------------------------
describe("submitBatch", () => {
  it("POSTs the payload as JSON to the IndexNow endpoint", async () => {
    const spy = stubFetch(async () => jsonResponse(200));
    const payload = buildPayload(["https://www.compute-atlas.com/table"]);
    await submitBatch(payload);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(INDEXNOW_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "content-type": "application/json; charset=utf-8" });
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it.each([400, 403, 422, 429, 500])("throws on HTTP %i", async (status) => {
    stubFetch(async () => jsonResponse(status, "rejected"));
    await expect(submitBatch(buildPayload(["https://www.compute-atlas.com/table"]))).rejects.toThrow(
      new RegExp(String(status))
    );
  });

  it("includes the response body in the thrown error", async () => {
    stubFetch(async () => jsonResponse(403, "Forbidden - key not valid"));
    await expect(submitBatch(buildPayload(["https://www.compute-atlas.com/table"]))).rejects.toThrow(
      /key not valid/
    );
  });

  it("accepts 202, which IndexNow returns for a queued request", async () => {
    stubFetch(async () => jsonResponse(202));
    await expect(
      submitBatch(buildPayload(["https://www.compute-atlas.com/table"]))
    ).resolves.toBe(202);
  });
});

// ---------------------------------------------------------------------------
// main — end-to-end, still entirely on mocked network
// ---------------------------------------------------------------------------
describe("main", () => {
  // ⚠️ THE mutation-tested check. Mutation-tested 2026-09-15 (submission made
  // the default): confirmed red, restored, confirmed green.
  //
  // Note HOW it goes red, because it is not via the `expect` below: the stub
  // THROWS on any call, so a submitting default makes `main` reject and the
  // test fails on the unhandled "dry run must not touch the network" before
  // the assertion is ever reached. The assertion is the backstop for a mutant
  // that reaches fetch some other way; the thrower is what actually bites
  // here. Both are deliberate — do not "simplify" the stub to a silent
  // resolve, which would leave only the assertion.
  it("sends NOTHING by default, given explicit URLs", async () => {
    const spy = stubFetch(() => {
      throw new Error("dry run must not touch the network");
    });
    await main(["/table"]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reads the sitemap but does not POST in a default run", async () => {
    const spy = stubFetch(async () =>
      jsonResponse(200, sitemapXml(["https://www.compute-atlas.com/table"]))
    );
    await main([]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe("https://www.compute-atlas.com/sitemap.xml");
    expect(spy.mock.calls.some((call) => call[0] === INDEXNOW_ENDPOINT)).toBe(false);
  });

  it("POSTs explicit URLs when --submit is passed", async () => {
    const spy = stubFetch(async () => jsonResponse(200));
    await main(["--submit", "/table", "/map"]);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(INDEXNOW_ENDPOINT);
    expect(JSON.parse(init.body as string).urlList).toEqual([
      "https://www.compute-atlas.com/table",
      "https://www.compute-atlas.com/map",
    ]);
  });

  it("surfaces a non-2xx instead of exiting cleanly", async () => {
    stubFetch(async () => jsonResponse(422, "Unprocessable"));
    await expect(main(["--submit", "/table"])).rejects.toThrow(/422/);
  });

  it("applies --limit before building the payload", async () => {
    const spy = stubFetch(async () => jsonResponse(200));
    await main(["--submit", "--limit=2", "/a", "/b", "/c"]);
    expect(JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string).urlList).toHaveLength(2);
  });

  it("rejects a foreign URL before any request is made", async () => {
    const spy = stubFetch(async () => jsonResponse(200));
    await expect(main(["--submit", "https://example.com/x"])).rejects.toThrow(/not on/);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// What the run SAYS — the caveat is the deliverable, not decoration
// ---------------------------------------------------------------------------
// This script's whole posture is "a 2xx is not an effect". That posture lives
// in printed copy, and copy is exactly the thing a green suite normally cannot
// see. These pin its substance (not its exact wording) so it cannot be quietly
// deleted or inverted.
describe("printed output", () => {
  describe("dry run", () => {
    beforeEach(() => {
      stubFetch(() => {
        throw new Error("dry run must not touch the network");
      });
    });

    it("says plainly that nothing was sent, and how to send", async () => {
      await main(["/table"]);
      expect(printed()).toMatch(/DRY RUN/);
      expect(printed()).toMatch(/nothing was sent/i);
      expect(printed()).toMatch(/--submit/);
    });

    // Pins the heading fix: a bare "POST <endpoint>" above a printed payload
    // reads as past tense, i.e. as though the request had been made.
    it("labels the payload as hypothetical, not as a request that happened", async () => {
      await main(["/table"]);
      expect(printed()).toMatch(/Would POST to/);
    });
  });

  describe("after a real submission", () => {
    beforeEach(() => {
      stubFetch(async () => jsonResponse(200));
    });

    // ⚠️ Mutation-tested 2026-09-15: rewriting the caveat to claim the
    // submission succeeded turns this red on the first unmatched assertion.
    it("states that a 2xx is not an effect, and where acceptance is actually visible", async () => {
      await main(["--submit", "/table"]);
      const output = printed();
      expect(output).toMatch(/2xx/);
      expect(output).toMatch(/NOT that any URL was accepted, fetched or indexed/);
      expect(output).toMatch(/Bing Webmaster Tools/);
      expect(output).toMatch(/unverified/);
    });

    it("says Google does not participate", async () => {
      await main(["--submit", "/table"]);
      expect(printed()).toMatch(/Google does not participate/);
    });

    // The negative half, and the one that catches a REWORDING rather than a
    // deletion. The correct copy contains "Acceptance"/"accepted" (inside the
    // disclaimer), so this cannot match on those; it targets the vocabulary of
    // a success claim, which the correct copy never uses.
    it("never claims the submission succeeded", async () => {
      await main(["--submit", "/table"]);
      expect(printed()).not.toMatch(/succe|confirm|\bworked\b|\bdone\b/i);
    });

    // A control for the three assertions above: they would all pass just as
    // happily against a `printed()` that captured nothing at all.
    it("control: printed() captures the run's output", async () => {
      await main(["--submit", "/table"]);
      expect(printed().length).toBeGreaterThan(0);
      expect(printed()).toMatch(/HTTP 200/);
    });
  });
});

// ---------------------------------------------------------------------------
// The hosted key file
// ---------------------------------------------------------------------------
// The whole protocol rests on `${KEY_LOCATION}` serving this exact string. A
// rotation that updates INDEXNOW_KEY without writing the matching file (or
// vice versa) would fail at submit time against a third-party service; here it
// fails in CI instead.
describe("public key file", () => {
  const contents = () =>
    readFileSync(new URL(`../public/${INDEXNOW_KEY}.txt`, import.meta.url), "utf8");

  it("exists at public/<key>.txt", () => {
    expect(() => contents()).not.toThrow();
  });

  it("contains exactly the key and nothing else", () => {
    expect(contents()).toBe(INDEXNOW_KEY);
  });

  it("has no trailing newline or surrounding whitespace", () => {
    const raw = contents();
    expect(raw).toBe(raw.trim());
    expect(raw).not.toMatch(/\s/);
  });

  it("uses a key in the character set and length IndexNow accepts", () => {
    expect(INDEXNOW_KEY).toMatch(/^[a-zA-Z0-9-]{8,128}$/);
  });
});

// ---------------------------------------------------------------------------
// next.config.ts must not intercept the key file
// ---------------------------------------------------------------------------
// The key file needs no entry in next.config.ts — `public/` is served as-is —
// but it does need NO rule to shadow it. `/data/:path+` requires at least one
// segment after `/data/`, so a root-level `.txt` is untouched by it; that is
// asserted here rather than assumed, using `getPathMatch`, the same compiler
// Next applies to a `source` (see next.config.test.ts's note on it).
//
// A failing version of this looks like: someone widens a static-asset rule to
// `/:path*.txt` or adds a catch-all redirect, and the key file starts serving a
// day-long edge cache or a 308 — either of which breaks host verification while
// the file itself is still perfectly present in `public/`.
describe("next.config.ts", () => {
  const keyPath = `/${INDEXNOW_KEY}.txt`;

  it("routes the key file through no rule but the baseline security headers", async () => {
    const rules = await nextConfig.headers!();
    const matching = rules.filter((rule) => getPathMatch(rule.source)(keyPath) !== false);
    expect(matching.map((rule) => rule.source)).toEqual(["/:path*"]);
  });

  // Positive control for the two assertions around it. Without it, both would
  // pass just as happily against a matcher that matched nothing at all — a
  // "no rule shadows this path" check is only informative once you have shown
  // the same predicate DOES fire on a path that is genuinely shadowed.
  it("control: a /data asset IS caught by the asset-cache rule", async () => {
    const rules = await nextConfig.headers!();
    const applied = rules
      .filter((rule) => getPathMatch(rule.source)("/data/water.geojson") !== false)
      .flatMap((rule) => rule.headers.map((header) => header.key));
    expect(applied).toContain("Cache-Control");
  });

  it("applies no Cache-Control to the key file", async () => {
    const rules = await nextConfig.headers!();
    const applied = rules
      .filter((rule) => getPathMatch(rule.source)(keyPath) !== false)
      .flatMap((rule) => rule.headers.map((header) => header.key));
    expect(applied).not.toContain("Cache-Control");
  });

  it("does not redirect the key file", async () => {
    const redirects = await nextConfig.redirects!();
    const matching = redirects.filter((rule) => getPathMatch(rule.source)(keyPath) !== false);
    expect(matching).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// robots.txt must not block the key fetch
// ---------------------------------------------------------------------------
// The engine fetches `/<key>.txt` as an ordinary crawler, so a Disallow that
// covered it would make every submission fail while the file itself was
// perfectly well served. Checked against the real robots route rather than
// asserted from memory.
describe("robots.txt", () => {
  const keyPath = `/${INDEXNOW_KEY}.txt`;
  const wildcardDisallows = (): string[] => {
    const rules = robots().rules;
    const wildcard = (Array.isArray(rules) ? rules : [rules]).find(
      (rule) => rule.userAgent === "*"
    );
    expect(wildcard).toBeDefined();
    return [wildcard?.disallow ?? []].flat();
  };

  // ⚠️ `startsWith` models a robots.txt path PREFIX and nothing else. It is
  // exactly right for today's ["/admin/", "/api/"], and silently WRONG for a
  // pattern: a future `Disallow: /*.txt$` blocks the key file outright while
  // sailing through a prefix test, which is the "passes green while being
  // wrong" shape. So any entry carrying wildcard or end-anchor syntax fails
  // here and demands a human evaluation, rather than being mis-modelled.
  it("uses no Disallow syntax this prefix check cannot model", () => {
    for (const entry of wildcardDisallows()) {
      expect(
        entry,
        `Disallow "${entry}" uses robots.txt wildcard/anchor syntax ('*' or '$'), which a ` +
          `prefix check cannot evaluate. Work out by hand whether it matches ${keyPath} and ` +
          "replace this test's matcher with one that models the pattern."
      ).not.toMatch(/[*$]/);
    }
  });

  it("does not disallow the key file for the default user-agent", () => {
    for (const entry of wildcardDisallows()) {
      expect(keyPath.startsWith(entry), `Disallow "${entry}" covers ${keyPath}`).toBe(false);
    }
  });

  // Positive control: the same predicate must fire on a path that IS blocked,
  // or the test above would pass against an empty/never-matching rule set.
  it("control: the same prefix check DOES catch a genuinely disallowed path", () => {
    const disallowed = wildcardDisallows();
    expect(disallowed.length).toBeGreaterThan(0);
    expect(disallowed.some((entry) => "/admin/login".startsWith(entry))).toBe(true);
  });
});
