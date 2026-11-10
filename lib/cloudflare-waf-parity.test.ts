import { describe, expect, it } from "vitest";

import {
  BLOCKED_AI_CRAWLERS,
  BLOCKED_BY_EDITORIAL_CHOICE,
  BLOCKED_BULK_EXTRACTORS,
  BLOCKED_SEO_CRAWLERS,
  BLOCKED_TO_MIRROR_EDGE,
} from "@/app/robots";

/**
 * ⚠️ READ THIS FIRST: THIS TEST CANNOT SEE CLOUDFLARE.
 *
 * The Cloudflare WAF rule below lives outside this repository. No assertion in
 * this file fetches it, and none could — a vitest run has no zone token, and
 * giving it one would make every PR depend on a live API. So this test proves
 * NOTHING about the edge's current state. It does exactly two things:
 *
 *   1. It makes the REPO side tamper-evident: changing `robots.txt`'s blocklist
 *      without reconciling it against the recorded WAF expectation turns this
 *      test red, forcing the person making the change to state which side they
 *      meant.
 *   2. It records the WAF expectation AS CHECKED-IN DATA, so updating it is a
 *      deliberate, reviewable edit with a date attached rather than a memory.
 *
 * WHY THAT IS WORTH HAVING ANYWAY. `app/robots.ts` and the WAF rules are two
 * independent lists with nothing else reconciling them, and they have drifted
 * badly: on 2026-09-27 the repo blocked 12 tokens while the WAF blocked 14, and
 * the WAF was INVERTED relative to the stated posture (it 403'd user-directed
 * retrieval agents while letting an indexing crawler through). Neither list was
 * wrong on its own terms; nothing ever compared them. Policy since 2026-10-15
 * (Ed), amended 2026-11-09: allow classic search engines (Googlebot, Bingbot,
 * DuckDuckBot), archives, AI assistants and AI search; block AI training
 * crawlers, bulk dataset extractors, SEO-resale crawlers and, by Ed's
 * 2026-11-09 choice, ChatGPT-User, OAI-SearchBot and Applebot, on BOTH sides. This test closes the
 * gap only on the side it can read.
 *
 * ⛔ Do NOT "improve" this into something that fetches Cloudflare. An assertion
 * that silently skips when a token is absent is worse than this file: it reads
 * green on every CI run, and green would then mean "no token", which is exactly
 * the unfalsifiable-signal trap this repo has paid for repeatedly (the drift
 * alert that failed 6/6 from birth; the watchdog that never parsed). If the
 * edge state must be verified mechanically, that belongs in a scheduled
 * workflow with a real token and a real alert on failure — not here.
 */

/**
 * The Cloudflare rules this file is reconciled against (zone ruleset
 * 2db189b07c9e4522bd6fc9b1fd5a4769); this file cannot re-read them.
 *
 *   - Rule 0cfdbaf2d09342f2ad93a0025bf9ff57: the AI Crawl Control rule, 23 UAs,
 *     matched by `http.user_agent contains`. MEASURED: read via the Cloudflare
 *     API 2026-11-10 ~00:45Z (ruleset v289). Arquivo-web-crawler reappeared
 *     when the rule changed at v289 (2026-11-10 00:09Z; cause not confirmed),
 *     and Ed decided to block it in robots.txt too. This test certifies the repo
 *     ledger, not the edge. Cloudflare regenerates the rule from
 *     its own dashboard crawler toggles, and a dashboard save does not keep
 *     manual additions. The four SEO crawlers it carried on 2026-09-27 were
 *     found missing on 2026-10-14; a dashboard save is the likely cause.
 *     Because the match is `contains "Applebot"`, the edge also blocks
 *     Applebot-Extended.
 *   - Custom rule "Block bulk dataset extractors": 8 UAs. MEASURED: read via
 *     the Cloudflare API 2026-10-15 13:58Z (last_updated 2026-10-15T13:57:34Z).
 *     It held 10 until the maintainer removed ExaSearchBot and Amzn-SearchBot
 *     that day. It is the 4 extractors plus the 4 SEO crawlers. Re-confirmed at 8
 *     UAs on 2026-11-09. Since 2026-11-09 it also blocks HTTP-library UAs
 *     (python-requests, curl/, etc.) on /facilities/* and /table only; those
 *     are not robots tokens and are not on this ledger.
 *     WAF matching is `contains` and case-sensitive, so Moz's crawler is entered
 *     as "DotBot" while this ledger keeps robots.txt's "dotbot".
 *
 * The two rules do not overlap, so the ledger below holds 23 + 8 entries.
 */
const WAF_RULE_UA_COUNT_AS_REPORTED = 23 + 8;

/**
 * The UAs the edge is recorded as blocking, transcribed from the rules above.
 * The WAF-only entries (EDGE_ONLY_UAS below) have no robots.txt counterpart, so
 * they never redden the reconciliation below.
 *
 * HOW TO MAINTAIN THIS. Change the WAF rules and this list in the same PR, and
 * move the date. Change `app/robots.ts` and this test tells you whether the WAF
 * needs the same change. The date is the load-bearing field: it says when a
 * human last looked, and nothing in this repo can keep it true.
 */
export const EXPECTED_WAF_BLOCKED_UAS = [
  // AI Crawl Control rule, 23 UAs (measured via the API, 2026-11-10 ~00:45Z,
  // v289, which re-included Arquivo-web-crawler; cause not confirmed).
  "Amazonbot",
  "Anchor Browser",
  "Applebot",
  "Arquivo-web-crawler",
  "Baiduspider",
  "Bytespider",
  "CCBot",
  "ChatGPT-User",
  "ClaudeBot",
  "CloudflareBrowserRenderingCrawler",
  "FacebookBot",
  "GPTBot",
  "Manus-User",
  "meta-externalagent",
  "meta-externalfetcher",
  "MistralAI-User",
  "Novellum",
  "OAI-SearchBot",
  "PetalBot",
  "ProRataInc",
  "Terracotta",
  "TikTokSpider",
  "Timpibot",
  // Custom rule "Block bulk dataset extractors", 8 UAs (measured via the API,
  // 2026-10-15 13:58Z; re-confirmed 2026-11-09).
  "DataForSeoBot",
  "dotbot",
  "QlyzeBot",
  "SERankingBacklinksBot",
  "Reflectionbot",
  "ShapBot",
  "Shap-User",
  "KorzyData",
] as const;

/**
 * Edge entries with no robots.txt counterpart. "Anchor Browser" is a
 * browser-automation product with no robots token. Baiduspider, Manus-User,
 * meta-externalfetcher, MistralAI-User and Terracotta were edge-only until Ed
 * decided on 2026-11-09 to block them in robots.txt too.
 */
const EDGE_ONLY_UAS = ["Anchor Browser"] as const;

/**
 * There is currently no robots-only exemption (every robots token is edge
 * blocked). To reintroduce one, re-add an annotated exemption map
 * (ROBOTS_ONLY_BY_DESIGN: token -> reason) and the guard tests that were
 * removed with it (accounted-for check, no robots-only/WAF contradiction,
 * reason-length check). See `git log -S ROBOTS_ONLY_BY_DESIGN`.
 */

/**
 * WAF matching is `contains`, so a ledger entry also covers any robots token it
 * is a substring of: "Applebot" covers "Applebot-Extended". The old
 * robots-only annotation for Applebot-Extended is gone: the edge blocks it too.
 */
function coveredByWaf(ua: string, wafSet: Set<string>): boolean {
  return [...wafSet].some((entry) => ua.includes(entry));
}

describe("robots.txt ↔ Cloudflare WAF reconciliation (repo side only — cannot read the edge)", () => {
  const robotsBlocked = [
    ...BLOCKED_AI_CRAWLERS,
    ...BLOCKED_BULK_EXTRACTORS,
    ...BLOCKED_SEO_CRAWLERS,
    ...BLOCKED_BY_EDITORIAL_CHOICE,
    ...BLOCKED_TO_MIRROR_EDGE,
  ];

  /**
   * The assertion that does the work. Every token `robots.txt` blocks must be
   * on the recorded WAF expectation, whether by exact name or by the edge's
   * `contains` match. Adding a crawler to `app/robots.ts` and
   * forgetting the edge is then a red test rather than a silent divergence.
   */
  it("accounts for every robots.txt block as WAF-enforced", () => {
    const wafSet = new Set<string>(EXPECTED_WAF_BLOCKED_UAS);
    const unaccounted = robotsBlocked.filter((ua) => !coveredByWaf(ua, wafSet));

    expect(
      unaccounted,
      "add each of these to EXPECTED_WAF_BLOCKED_UAS (and to the Cloudflare rule)"
    ).toEqual([]);
  });

  /**
   * Exact-set check: the ledger must be precisely every robots.txt token the
   * edge matches literally, plus the known edge-only entries. Catches a stray or
   * misspelled ledger entry that the one-way check above lets through. Tokens
   * are compared as the ledger stores them (robots.txt casing, so "dotbot" even
   * though the WAF string is "DotBot"). Tokens covered only through `contains`
   * (Applebot-Extended, via "Applebot") are not ledger entries.
   */
  it("records exactly the literally matched robots.txt tokens, plus the edge-only entries", () => {
    const wafSet = new Set<string>(EXPECTED_WAF_BLOCKED_UAS);
    const expected = new Set<string>([
      ...robotsBlocked.filter((ua) => wafSet.has(ua)),
      ...EDGE_ONLY_UAS,
    ]);
    expect([...EXPECTED_WAF_BLOCKED_UAS].sort()).toEqual([...expected].sort());
    // Every token the edge matches by `contains` alone must be one we know about.
    expect(robotsBlocked.filter((ua) => !wafSet.has(ua))).toEqual(["Applebot-Extended"]);
  });

  /**
   * Keeps the transcript honest about being a transcript. The live rules were
   * reported at 31 UAs (23 + 8). A list that GREW past the reported count means
   * the count note is stale and must be re-verified before the extra entries
   * can be trusted — so this fails upward, not downward.
   */
  it("never records more WAF blocks than the rule was reported to carry", () => {
    expect(EXPECTED_WAF_BLOCKED_UAS.length).toBeLessThanOrEqual(WAF_RULE_UA_COUNT_AS_REPORTED);
  });

  it("records no duplicate UA on either ledger", () => {
    expect(new Set(EXPECTED_WAF_BLOCKED_UAS).size).toBe(EXPECTED_WAF_BLOCKED_UAS.length);
    expect(new Set(robotsBlocked).size).toBe(robotsBlocked.length);
  });

  /**
   * HISTORICAL: on 2026-09-27 the edge was found INVERTED, with a rule that
   * 403'd user-directed retrieval agents while letting an indexing crawler
   * through.
   * `Google-Extended` is exempt from `app/robots.ts` on purpose (the dataset
   * wants to be cited in AI Overviews), so it must not appear on the WAF ledger
   * either — a WAF block would silently override the exemption this project
   * goes out of its way to preserve, and no robots.txt test would notice.
   */
  it("never records a WAF block for a crawler robots.txt deliberately exempts", () => {
    const deliberatelyAllowed = [
      "Google-Extended",
      "Googlebot",
      "archive.org_bot",
      "AhrefsBot",
      "SemrushBot",
      "PerplexityBot",
      "Claude-SearchBot",
      "Claude-User",
      "Perplexity-User",
      "ExaSearchBot",
      "Amzn-SearchBot",
      "DuckAssistBot",
    ];
    const wafSet = new Set<string>(EXPECTED_WAF_BLOCKED_UAS);

    expect(deliberatelyAllowed.filter((ua) => wafSet.has(ua))).toEqual([]);
  });
});
