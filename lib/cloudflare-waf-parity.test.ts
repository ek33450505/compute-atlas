import { describe, expect, it } from "vitest";

import { BLOCKED_AI_CRAWLERS, BLOCKED_SEO_CRAWLERS } from "@/app/robots";

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
 * WHY THAT IS WORTH HAVING ANYWAY. `app/robots.ts` and the WAF rule were two
 * independent lists with nothing reconciling them, and they drifted badly: the
 * repo blocked 12 tokens while the WAF blocked 18 (now 14), and the WAF was
 * INVERTED — it 403'd user-directed retrieval agents (which this project wants:
 * see the "TRAINING crawlers blocked, RETRIEVAL allowed" position, and
 * Google-Extended's deliberate exemption in app/robots.ts) while allowing an
 * indexing crawler through. Neither list was wrong on its own terms; nothing
 * ever compared them. That is the gap this closes, and it closes it only on the
 * side a test can read.
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
 * The Cloudflare WAF rule this file is reconciled against.
 *
 *   Zone ruleset: 2db189b07c9e4522bd6fc9b1fd5a4769
 *   Rule:         0cfdbaf2d09342f2ad93a0025bf9ff57
 *   Last reported by a human with zone access: 2026-09-27 — 14 UAs blocked.
 */
const WAF_RULE_UA_COUNT_AS_REPORTED = 14;

/**
 * The subset of that rule's UAs this repo can state. ⚠️ IT IS INCOMPLETE ON
 * PURPOSE, AND THE GAP IS THE HONEST PART.
 *
 * These nine are the tokens `app/robots.ts` blocks that were reported as also
 * enforced at the edge. The live rule carries
 * `WAF_RULE_UA_COUNT_AS_REPORTED` (14), so FIVE entries are not transcribed
 * here — they were not available when this file was written, and inventing
 * plausible crawler names to make the count line up would have produced a
 * transcript that reads authoritative and is fiction. An incomplete list that
 * says so is worth more than a complete-looking one that cannot be trusted.
 *
 * 📌 OWED: whoever next opens the Cloudflare rule should paste the remaining
 * five names in and bump the date. The reconciliation below is unaffected by
 * the gap — a WAF-only entry has no robots.txt counterpart by definition, which
 * is exactly the category those five fall into — so this is a completeness
 * debt, not a correctness one.
 *
 * HOW TO MAINTAIN THIS. Change the WAF rule and this list in the same PR, and
 * move the date. Change `app/robots.ts` and this test tells you whether the WAF
 * needs the same change. The date is the load-bearing field: it says when a
 * human last looked, and nothing in this repo can keep it true.
 */
export const EXPECTED_WAF_BLOCKED_UAS = [
  "Amazonbot",
  "Bytespider",
  "CCBot",
  "DataForSeoBot",
  "dotbot",
  "GPTBot",
  "meta-externalagent",
  "QlyzeBot",
  "SERankingBacklinksBot",
] as const;

/**
 * Tokens `robots.txt` blocks ON PURPOSE without a matching WAF rule, each with
 * the reason. This is the escape hatch that keeps the assertion below honest:
 * without it, the only way to make the test pass would be to add a WAF entry
 * that may not be wanted, and the pressure would be to weaken the test instead.
 *
 * A robots-only block is a REQUEST, not enforcement — it works on a crawler
 * that reads robots.txt and does nothing to one that ignores it. That is the
 * deliberate choice for all three below.
 *
 * ⚠️ The three entries' ROBOTS-ONLY STATUS was reported by a human with zone
 * access (2026-09-27); the REASONS are this change's own reasoning about why
 * that is the right call, not a quotation of a prior decision. Treat them as
 * revisable — if a reason is wrong, fix the reason rather than deleting the
 * entry, which would only redden the test.
 */
const ROBOTS_ONLY_BY_DESIGN: Record<string, string> = {
  "Applebot-Extended":
    "Training opt-out only. Apple honours it via robots.txt and blocking Applebot-Extended at the edge risks catching Applebot itself (same UA prefix), which would cost Siri/Spotlight surfacing.",
  ClaudeBot:
    "Training crawler, declines by robots.txt. Left unenforced at the edge so a UA-matching mistake cannot also 403 Claude's user-directed retrieval fetches, which this project wants to allow.",
  CloudflareBrowserRenderingCrawler:
    "Cloudflare's own renderer. A WAF rule on Cloudflare's own fetcher is a foot-gun (it also backs features we may use); robots.txt is the right register for it.",
};

describe("robots.txt ↔ Cloudflare WAF reconciliation (repo side only — cannot read the edge)", () => {
  const robotsBlocked = [...BLOCKED_AI_CRAWLERS, ...BLOCKED_SEO_CRAWLERS];

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
   * The reverse direction, and it is NOT symmetric with the check above. A WAF
   * entry with no robots.txt counterpart is legitimate — the edge can enforce
   * against crawlers we never bothered to name in robots.txt (the five listed
   * as such above). What is NOT legitimate is a robots-only ANNOTATION for a
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
   * Keeps the transcript honest about being a transcript. The live rule was
   * reported at 14 UAs; this file can name 9. A list that GREW past the
   * reported count means the count note is stale and must be re-verified before
   * the extra entries can be trusted — so this fails upward, not downward, and
   * deliberately does NOT demand the gap be closed (that would make the only
   * green path "invent five names", the mistake this file's header warns about).
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
    const deliberatelyAllowed = ["Google-Extended", "Googlebot", "AhrefsBot", "SemrushBot"];
    const wafSet = new Set<string>(EXPECTED_WAF_BLOCKED_UAS);

    expect(deliberatelyAllowed.filter((ua) => wafSet.has(ua))).toEqual([]);
  });
});
