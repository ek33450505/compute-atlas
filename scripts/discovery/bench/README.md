# Ollama model bench — Track 5 field extraction

Local, reproducible. Scores a model on **real cached pages from the live dataset**
(not synthetic text) for the Track 5 job: extract ONE field about ONE named
facility, or correctly return null.

    node scripts/discovery/bench/run.mjs <model-tag>     # writes result-<model>.json
    node scripts/discovery/bench/rescore.mjs             # re-scores ALL results against verified truth

(Both are also runnable from inside this directory — `cd scripts/discovery/bench && node run.mjs <model-tag>`.)

`rescore.mjs` holds the ground truth and is the file to trust — `run.mjs`'s inline
labels were authored from assumption and were **wrong on 3 of 14 cases**, each time
penalising a model for being correct. Re-verify any label by reading the
surrounding context in `pages.json`, not by grepping for a number:
"20 acres" on the Flexential page covers FOUR facilities, so abstaining is right.

Scoring is asymmetric on purpose: hallucination and wrong-value are **-2**,
correct value and correct abstention **+1**, a miss **0**. Inventing a number for
a field the page never states is the failure that puts a fabricated fact behind a
real citation.

To refresh the page cache: `node scripts/discovery/bench/fetch-pages.mjs` (re-fetches from `targets.json`).

⚠️ **Refreshing the corpus now changes the cached text, even for a page whose
HTML hasn't changed.** `fetch-pages.mjs` extracts through `html.mjs`'s
`htmlToText` (a hand-ported copy of the shipped `fetch-page-text.ts`), which
decodes HTML entities (`&amp; &lt; &gt; &quot; &#39; &nbsp;` and decimal
numeric entities) that the bench's prior inline chain left raw. The labels in
`truth.json` were assigned by reading the CURRENT (pre-decode) cached text, so
re-running `fetch-pages.mjs` — even in its default additive mode, for any
target it re-fetches — will shift entity-bearing spans in ways a label may no
longer describe verbatim. **Do not refresh any part of the corpus without
re-verifying the labels it affects.** The existing result files
(`result-gpt-oss_20b*.json`) were measured against the pre-decode text and are
not invalidated by this change — a full re-check of every real model quote in
every result file against the decoded text found 0 verdict flips — but a
fresh fetch from here forward will not match them byte-for-byte.

## Why this is version-controlled

This directory is the calibration evidence behind the shipped Track 5 tool's
(`scripts/discovery/extract-fields.ts`) headline claim — PRECISION 90% / RECALL
84% / ABSTENTION-ACC 96%, reproduced by `rescore.mjs` against 31 real cached
pages. (The corpus is now 69 pages; those headline numbers come from the four
NUMERIC fields, which are labeled on the original 31 only — the 38 pages added
for `coolingType` carry a coolingType label and nothing else, and `rescore.mjs`
excludes and names every unlabeled cell rather than scoring it as an abstention.) A claim like that is only worth anything if the harness that produced it
stays inspectable and re-runnable, so `pages.json`, `truth.json`,
`result-gpt-oss_20b.json`, and the scoring/fetch/build scripts all live here in
git rather than in a gitignored scratch directory.

`quote.mjs` is a deliberate exception to "don't duplicate logic": it is an
independent JS port of the exact same quote-grounding gate that
`extract-fields.ts` implements in TypeScript (the TS copy was hand-ported from
this file — see that file's Stage 5 header comment). The bench's P/R numbers are
computed against `quote.mjs`, not against `extract-fields.ts`, so if the two
implementations ever drift apart, the bench's numbers quietly stop describing
the shipped tool while still looking authoritative. `quote-parity.test.ts` is
what makes that duplication safe — it runs both implementations over real
model quotes (from `result-gpt-oss_20b.json`) and hand-curated edge cases, and
fails the moment they disagree. Run it after touching either gate:

    npx vitest run scripts/discovery/bench/quote-parity.test.ts

## coolingType, and why two result files for one model

`result-gpt-oss_20b-coolingType.json` and `result-gpt-oss_20b-coolingType-norule.json`
are the same 69 pages, the same model and the same labels, run against two versions of
the `coolingType` prompt. They are kept side by side because the difference between them
is the finding:

| | prompt lists the vocabulary only | prompt also states the decision rule |
|---|---|---|
| PRECISION | 53% | **95%** |
| RECALL | 42% | **95%** |
| ABSTENTION-ACC | 98% | **100%** |
| WRONG / HALLUC | 6 / 1 | **1 / 0** |

Eight of the twelve error cells in the rule-free run were one case: a page whose true
value is `closed_loop` — a recirculating circuit that the operator markets as "air
cooling" — answered `air`, `hybrid`, or nothing at all. Only 4 of the 12 `closed_loop`
pages came out right without the rule; all 12 did with it. That is the same misreading a human curator made on `edgecore-mesa-az`,
and it is why the rule was written into `docs/methodology.md` and `lib/schema.ts` in the
first place. The model could not apply a rule it was never given. **A categorical field's
score measures the prompt as much as the model** — do not quote an enum field's number
without saying which prompt produced it.

`-norule` is a frozen artifact: `run.mjs` will never write that filename, so re-running
the bench updates the with-rule file and leaves the comparison intact.

⚠️ Two things this corpus does NOT measure. `hybrid` has **zero** positive labels — no
cached page states a design that switches between evaporative and dry modes — so a
`hybrid` answer is unverified by construction even though the model can emit one. And
five pages (7%) are labeled `AMBIG` and excluded: they say what a design is *not*, or
support two values at once.

**Both label corrections in this corpus came from the model disagreeing with me.**
`crane-pdx02-forest-grove-or` really does say "air-based cooling" — buried mid-run in a
comma-separated design list my sentence-splitting label aid truncated — and was scored a
hallucination for being right. `atlas-power-williston-nd`'s "closed-loop cooling system"
sentence belongs to a *different operator's* project in baxtel's nearby-facilities
sidebar; the model abstained and was scored a miss for being right. Read every
disagreement as a possible label bug before recording it as a model error.

## aiClassification, and a rule that bought willingness instead of accuracy

`result-gpt-oss_20b-aiClassification.json` and `result-gpt-oss_20b-aiClassification-norule.json`
are the same 69 pages, the same model and the same labels, run against two versions of the
`aiClassification` prompt — the full decision rule from
`docs/methodology.md#ai-classification`, and a bare vocabulary list with no definitions and no
tie-breakers. Measured 2026-09-12.

| | vocabulary only | + the decision rule |
|---|---|---|
| PRECISION | 56% | **61%** |
| RECALL | 43% | **83%** |
| ABSTENTION-ACC | **89%** | 82% |
| correct / correct-abstain | 10 / 39 | 19 / 36 |
| miss | 10 | **0** |
| WRONG / HALLUC | 3 / 5 | 4 / **8** |
| score | **33** | 31 |

**This is NOT the coolingType result, and the difference is the finding.** There, the rule took
the model from P=53%/R=42% to P=95%/R=95% and removed its last hallucination — a real gain in
discrimination, because the model had simply never been given a rule it could apply. Here the
rule roughly doubles recall (43% → 83%, misses 10 → 0) while precision stays essentially flat
(56% → 61%) and hallucinations go **up** (5 → 8). Correct abstentions fall from 39 to 36. The
asymmetric score, which charges -2 for a fabrication, actually gets *worse*: 33 → 31.

⇒ **The rule made the model more willing to commit, not better at telling the cases apart.** It
converted abstentions into answers; some were right, and some were fabrications.

**`likely` is where the error lives.** Split by the value the model chose:

| model answered | times | correct |
|---|---|---|
| `confirmed` | 14 | 13 (93%) |
| `mixed_use` | 4 | 2 |
| `likely` | 13 | **4 (31%)** |

Seven of the eight with-rule hallucinations answered `likely` on a page that ties the facility
to nothing — and every one of those pages is capability marketing or industry context, which
TIE-BREAKER 1 and TIE-BREAKER 2 exclude by name. On `cologix-johnstown-oh` the model quoted
`"new, AI-ready data center campus"` and answered `likely`; "AI-ready" is the literal example
TIE-BREAKER 1 uses to say that marketing establishes no tier. On
`air-products-cetronia-road-upper-macungie-pa` it quoted `"tech companies across the country are
looking to build..."`, which is TIE-BREAKER 2's industry-context case verbatim. The rule was in
the prompt both times.

The reason is structural. `confirmed` and `mixed_use` ask what a page *states*. `likely` asks
whether a stated indicator is *substantive enough* to imply AI use — a judgement the page does
not contain. A decision rule can teach a model to apply a distinction the text supports; it
cannot supply a fact the text never carries.

⚠️ **Do not conclude "drop `likely` and ship `confirmed` at 93%".** That 93% is measured on a run
where `likely` was available to absorb the marketing pages, and the no-rule run shows what
happens when it is less accessible: on `edgecore-mesa-az` and `cologix-johnstown-oh` the model
fabricated under BOTH prompts, answering `confirmed` without the rule and `likely` with it. The
rule changed which value it invented, not whether it invented one. A restricted-vocabulary score
cannot be inferred from a full-vocabulary run, because the model reallocates its errors onto
whatever values remain — it must be measured with its own run.

**Status: NOT pinned, and deliberately not wired into `scripts/discovery/extract-fields.ts`.**
`aiClassification` is not an `ExtractableField`, so the nightly lane cannot produce it. At P=61%
it is far below the two pinned fields (`capacityMw.operational` 100/100,
`water.coolingType` 95/95). This is the bench doing its job: issue #214's classification half was
blocked on exactly this measurement, and the answer is that the local model cannot source this
field at publishable quality.

⚠️ Two limits on the labels themselves. They are **single-pass** — no page was double-labelled,
so inter-annotator agreement is unmeasured. And the corpus carries only **4** positive `likely`
labels and **4** `mixed_use` (against 15 `confirmed` and 44 `null`), so neither supports a
per-value precision figure; the 31% and 93% above are descriptive of this run, not pinned rates.
The one boundary that produced genuine disagreement between labellers is the same one the model
fails on: whether a GPU-specific cooling-capability spec on a facility's own page is an
indicator or marketing. That ambiguity is in the dataset's rule, not just the bench, so it will
reach human curators classifying the remaining unclassified records too.
