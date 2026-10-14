import { describe, expect, it } from "vitest";

import {
  BLOCKED_AI_AGENTS,
  BLOCKED_AI_CRAWLERS,
  BLOCKED_BULK_EXTRACTORS,
  BLOCKED_SEO_CRAWLERS,
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
 * wrong on its own terms; nothing ever compared them. Policy since 2026-10-14
 * (Ed): allow classic search engines (Googlebot, Bingbot, Applebot,
 * DuckDuckBot) and archives; block AI training crawlers, AI agents / AI-search
 * indexers and bulk dataset extractors, on BOTH sides. This test closes the
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
 * The Cloudflare rules this file is reconciled against. Read by API by the
 * dispatching session on 2026-10-14 (zone ruleset 2db189b07c9e4522bd6fc9b1fd5a4769,
 * v259); this file cannot re-read them.
 *
 *   - Rule 0cfdbaf2d09342f2ad93a0025bf9ff57: the AI Crawl Control rule, 23 UAs.
 *     Cloudflare regenerates it from its own dashboard crawler toggles, and a
 *     dashboard save does not keep manual additions. The four SEO crawlers it
 *     carried on 2026-09-27 were found missing on 2026-10-14; a dashboard save
 *     is the likely cause, but the actual drop date is unknown.
 *   - Custom rule "Block bulk dataset extractors": 10 UAs (the 6 extractors plus
 *     the four SEO crawlers re-added there, since WAF matching is `contains` and
 *     case-sensitive, Moz's crawler is entered as "DotBot" while this ledger
 *     keeps robots.txt's "dotbot").
 *
 * The two rules do not overlap, so the ledger below holds 23 + 10 entries.
 */
const WAF_RULE_UA_COUNT_AS_REPORTED = 23 + 10;

/**
 * The UAs the edge is recorded as blocking, transcribed from the rules above.
 * "Anchor Browser" is WAF-only: a browser-automation product with no robots.txt
 * token. A WAF-only entry has no robots.txt counterpart by definition, so it
 * never reddens the reconciliation below.
 *
 * HOW TO MAINTAIN THIS. Change the WAF rules and this list in the same PR, and
 * move the date. Change `app/robots.ts` and this test tells you whether the WAF
 * needs the same change. The date is the load-bearing field: it says when a
 * human last looked, and nothing in this repo can keep it true.
 */
export const EXPECTED_WAF_BLOCKED_UAS = [
  // AI Crawl Control rule, 23 UAs (2026-10-14).
  "Amazonbot",
  "Anchor Browser",
  "Arquivo-web-crawler",
  "Bytespider",
  "CCBot",
  "ChatGPT-User",
  "Claude-User",
  "ClaudeBot",
  "CloudflareBrowserRenderingCrawler",
  "DuckAssistBot",
  "FacebookBot",
  "GPTBot",
  "Manus-User",
  "meta-externalagent",
  "meta-externalfetcher",
  "MistralAI-User",
  "Novellum",
  "OAI-SearchBot",
  "Perplexity-User",
  "PetalBot",
  "ProRataInc",
  "TikTokSpider",
  "Timpibot",
  // Custom rule "Block bulk dataset extractors", 10 UAs (2026-10-14).
  "DataForSeoBot",
  "dotbot",
  "QlyzeBot",
  "SERankingBacklinksBot",
  "ExaSearchBot",
  "Amzn-SearchBot",
  "Reflectionbot",
  "ShapBot",
  "Shap-User",
  "KorzyData",
] as const;

/**
 * Tokens `robots.txt` blocks ON PURPOSE without a matching WAF rule, each with
 * the reason. This is the escape hatch that keeps the assertion below honest:
 * without it, the only way to make the test pass would be to add a WAF entry
 * that may not be wanted, and the pressure would be to weaken the test instead.
 *
 * A robots-only block is a REQUEST, not enforcement — it works on a crawler
 * that reads robots.txt and does nothing to one that ignores it. That is the
 * deliberate choice for the entry below.
 *
 * ⚠️ The entry's ROBOTS-ONLY STATUS was reported by a human with zone
 * access (2026-09-27, re-confirmed absent from the 2026-10-14 rules; ClaudeBot
 * and CloudflareBrowserRenderingCrawler, robots-only then, are now WAF-enforced
 * and moved to the ledger above); the REASON are this change's own reasoning about why
 * that is the right call, not a quotation of a prior decision. Treat them as
 * revisable — if a reason is wrong, fix the reason rather than deleting the
 * entry, which would only redden the test.
 */
const ROBOTS_ONLY_BY_DESIGN: Record<string, string> = {
  "Applebot-Extended":
    "Training opt-out only. Apple honours it via robots.txt and blocking Applebot-Extended at the edge risks catching Applebot itself (same UA prefix), which would cost Siri/Spotlight surfacing.",
};

describe("robots.txt ↔ Cloudflare WAF reconciliation (repo side only — cannot read the edge)", () => {
  const robotsBlocked = [
    ...BLOCKED_AI_CRAWLERS,
    ...BLOCKED_AI_AGENTS,
    ...BLOCKED_BULK_EXTRACTORS,
    ...BLOCKED_SEO_CRAWLERS,
  ];

  /**
   * The assertion that does the work. Every token `robots.txt` blocks must be
   * accounted for on exactly one of two ledgers: the recorded WAF expectation,
   * or the annotated robots-only list. Adding a crawler to `app/robots.ts` and
   * forgetting the edge is then a red test rather than a silent divergence.
   */
  it("accounts for every robots.txt block as either WAF-enforced or annotated robots-only", () => {
    const wafSet = new Set<string>(EXPECTED_WAF_BLOCKED_UAS);
    const unaccounted = robotsBlocked.filter(
      (ua) => !wafSet.has(ua) && !(ua in ROBOTS_ONLY_BY_DESIGN)
    );

    expect(
      unaccounted,
      "add each of these to EXPECTED_WAF_BLOCKED_UAS (and to the Cloudflare rule) " +
        "or to ROBOTS_ONLY_BY_DESIGN with a reason"
    ).toEqual([]);
  });

  /**
   * Exact-set check: the ledger must be precisely every robots.txt token minus
   * the robots-only exemptions, plus the one known edge-only entry. Catches a
   * stray or misspelled ledger entry that the one-way checks above let through.
   * Tokens are compared as the ledger stores them (robots.txt casing, so
   * "dotbot" even though the WAF string is "DotBot").
   */
  it("records exactly the robots.txt tokens not exempted, plus the edge-only entries", () => {
    const expected = new Set<string>([
      ...robotsBlocked.filter((ua) => !(ua in ROBOTS_ONLY_BY_DESIGN)),
      "Anchor Browser",
    ]);
    expect([...EXPECTED_WAF_BLOCKED_UAS].sort()).toEqual([...expected].sort());
  });

  /**
   * The reverse direction, and it is NOT symmetric with the check above. A WAF
   * entry with no robots.txt counterpart is legitimate — the edge can enforce
   * against crawlers we never bothered to name in robots.txt (e.g. "Anchor Browser"). What is NOT legitimate is a robots-only ANNOTATION for a
   * token the WAF also blocks: that annotation would be a false statement about
   * the edge, and a reader would trust it.
   */
  it("never annotates a token as robots-only while the WAF is recorded as blocking it", () => {
    const wafSet = new Set<string>(EXPECTED_WAF_BLOCKED_UAS);
    const contradictory = Object.keys(ROBOTS_ONLY_BY_DESIGN).filter((ua) => wafSet.has(ua));

    expect(contradictory).toEqual([]);
  });

  /**
   * Guards the escape hatch itself. An entry with an empty or throwaway reason
   * turns `ROBOTS_ONLY_BY_DESIGN` into a bypass list — the cheapest way to make
   * the first test green is to add a name and no explanation, and this makes
   * that fail. 40 characters is arbitrary but forces a sentence rather than a
   * word; the repo has seen a "non-empty" placeholder check pass 45 times
   * without ever reading the placeholder.
   */
  it("requires a real reason for every robots-only exemption", () => {
    for (const [ua, reason] of Object.entries(ROBOTS_ONLY_BY_DESIGN)) {
      expect(reason.trim().length, `${ua}'s exemption reason is too thin to review`).toBeGreaterThan(
        40
      );
    }
  });

  /**
   * Keeps the transcript honest about being a transcript. The live rules were
   * reported at 33 UAs (23 + 10). A list that GREW past the reported count means
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
   * The inversion that was actually found at the edge: a rule that 403'd
   * user-directed retrieval agents while letting an indexing crawler through.
   * `Google-Extended` is exempt from `app/robots.ts` on purpose (the dataset
   * wants to be cited in AI Overviews), so it must not appear on the WAF ledger
   * either — a WAF block would silently override the exemption this project
   * goes out of its way to preserve, and no robots.txt test would notice.
   */
  it("never records a WAF block for a crawler robots.txt deliberately exempts", () => {
    const deliberatelyAllowed = [
      "Google-Extended",
      "Googlebot",
      "AhrefsBot",
      "SemrushBot",
      "PerplexityBot",
      "Claude-SearchBot",
    ];
    const wafSet = new Set<string>(EXPECTED_WAF_BLOCKED_UAS);

    expect(deliberatelyAllowed.filter((ua) => wafSet.has(ua))).toEqual([]);
  });
});
