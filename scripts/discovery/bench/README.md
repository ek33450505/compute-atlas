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

## aiClassificationStated — removing the soft tier, and what moved instead

`result-gpt-oss_20b-aiClassificationStated.json` is the same 69 cached pages and the same model
run against a TWO-value vocabulary — `confirmed` | `mixed_use`, with `likely` deleted — to test
the obvious follow-up to the section above. Measured 2026-09-12. The four pages whose true label
is `likely` carry no label for this field, so 63 cells are scored.

⚠️ Those four are skipped by `run.mjs` at GENERATION time, not by `rescore.mjs` at scoring time —
they are named in the result file's own `skipped` array and never become rows. So `rescore.mjs`'s
"UNLABELED (not scored, NOT measured)" line correctly reads 0 for this file, which is not a
contradiction: there was nothing left for it to exclude.

| | 3-value, no rule | 3-value + rule | **2-value + rule** |
|---|---|---|---|
| PRECISION | 56% | 61% | **85%** |
| RECALL | 43% | 83% | **89%** |
| ABSTENTION-ACC | 89% | 82% | **95%** |
| correct / correct-abstain | 10 / 39 | 19 / 36 | 17 / **42** |
| miss | 10 | 0 | 1 |
| WRONG / HALLUC | 3 / 5 | 4 / 8 | **1 / 2** |
| score | 33 | 31 | **53** |

**A prediction was registered before this run, and it was wrong.** The expectation — written up in
the section above — was that deleting `likely` would push its fabrications onto `confirmed`,
because the no-rule run had already shown the model answering `confirmed` on two of those same
marketing pages. Of the seven pages that drew a `likely` hallucination in the three-value run,
**six abstained correctly here and none returned `confirmed`.** Only `edgecore-mesa-az` still
fabricated, and it chose `mixed_use`.

So the reallocation effect is real but far weaker than predicted, and it lands somewhere else.
Hallucinations fell 8 → 2 and the asymmetric score rose 31 → 53.

**The residual failure is entirely `mixed_use`.** Split by the value the model chose:

| model answered | times | correct |
|---|---|---|
| `confirmed` | 14 | **14 (100%)** |
| `mixed_use` | 6 | 3 (50%) |

Every error in this run — both hallucinations and the one wrong value — involves `mixed_use`.
`confirmed` was answered 14 times and was right every time, with recall 14/15.

The cause is visible in the prompt itself. `mixed_use` is defined as "cloud and AI", and the
pages it fires on falsely are marketing copy reading "AI & Cloud-Ready Campuses" — the definition
hands the model a template that the marketing phrase matches almost verbatim. `aligned-phx-01-02-03-az`
is the clearest case: correctly `null` in the three-value run, `mixed_use` here, quoting
"AI & Cloud-Ready Campuses in Phoenix". TIE-BREAKER 1 says that establishes no tier, but the
tier's own wording argues the other way.

⚠️ **Do NOT read the 100% as "ship a `confirmed`-only extractor at 100%".** That is the same
inference this bench already disproved once. The 100% was measured with `mixed_use` present to
absorb the marketing pages; delete it and those three fabrications must land somewhere, and
`confirmed` is what remains. The rule has now been demonstrated twice in one corpus: **a model
reallocates its errors onto whatever values remain, so a restricted-vocabulary score cannot be
inferred from a wider-vocabulary run.** A `confirmed`-only variant is the next experiment and needs
its own run — and this time the prediction should be written down first again.

**Status: still NOT wired into `scripts/discovery/extract-fields.ts`.** Neither `aiClassification`
nor `aiClassificationStated` is an `ExtractableField`. At P=85% the two-value field remains below
the pinned bar (`capacityMw.operational` 100/100, `water.coolingType` 95/95) — but it is close
enough, and its residual failure specific enough, that the path is no longer closed. That is a
material change from the three-value conclusion.

⚠️ Sample sizes bound all of this: 15 `confirmed`, 4 `mixed_use` and 44 `null` labels. The 100% is
14 of 14 — a wide interval, not a pinned rate. Labels remain single-pass, so inter-annotator
agreement is unmeasured.

## mixed_use rewording — a prediction registered before the run

Registered 2026-09-13, BEFORE the run, per the discipline the previous section established after a
prediction was falsified. The change under test is ONE clause: `mixed_use`'s definition in
`run.mjs`'s `aiClassificationStated` prompt. `confirmed`'s wording, all three tie-breakers, the
vocabulary, the labels and the 69-page corpus are untouched. The pre-revision result is frozen at
`result-gpt-oss_20b-aiClassificationStated-mixedusev1.json`.

What I predict:

1. Both hallucinations disappear and become correct abstentions. `aligned-phx-01-02-03-az`, which
quoted "AI & Cloud-Ready Campuses", returns null.
2. `confirmed` stays 14 answered / 14 correct. Nothing in its definition changed.
3. PRECISION 85% -> >=93%. ABSTENTION-ACC 95% -> >=97%. Score 53 -> >=60.
4. RECALL does NOT fall below 85% — at most ONE additional miss. This is the risk side: only four
positive `mixed_use` labels exist, and a tighter definition can suppress a true one.

The counter-hypothesis I am betting against: the reallocation rule ("a model reallocates its errors
onto whatever values remain") has now held twice in this corpus. I predict it does NOT bite here,
because this intervention differs in kind from deleting `likely` — `mixed_use` still exists as a
landing site, it is only harder to trigger. If errors DO land on `confirmed` instead, the rule is
stronger than I think and generalises from removing a value to narrowing a definition.

What falsifies each clause: (1) fails if either page returns a non-null value; (2) fails if
`confirmed` is answered a different number of times or is wrong once; (3) fails on any metric below
its floor; (4) fails if recall < 85%, i.e. two or more additional misses. A partial result is still
a result — record which clauses held, not an overall verdict.

### The result: the prediction was wrong on every clause but one

Measured 2026-09-13, same 69 pages, same model, `temperature: 0`. **The rewording is worse and was
reverted.** Its output is frozen at `result-gpt-oss_20b-aiClassificationStated-mixedusev2.json`;
`run.mjs` carries the original wording again.

| | v1 (original) | v2 (reworded) |
|---|---|---|
| PRECISION | **85%** | 72% |
| RECALL | **89%** | 68% |
| ABSTENTION-ACC | 95% | **98%** |
| correct / correct-abstain | 17 / 42 | 13 / 43 |
| miss | **1** | 2 |
| WRONG / HALLUC | **1 / 2** | 4 / 1 |
| score | **53** | 46 |

Scored against the pre-registration: clause 1 half-held — `aligned-phx-01-02-03-az` did return null,
but `edgecore-mesa-az` still fabricated. Clause 2 failed outright. Clause 3 failed: precision fell
13 points instead of rising 8. Clause 4 failed: recall fell 21 points, not the one-miss ceiling.

**Exactly six of 65 cells changed, and the shape of the change is the finding.**

| facility | truth | v1 | v2 |
|---|---|---|---|
| `aligned-phx-01-02-03-az` | null | mixed_use ✗ | **null ✓** |
| `applied-digital-polaris-forge-1-ellendale-nd` | confirmed | confirmed ✓ | mixed_use ✗ |
| `dc-blox-atlanta-west-ga` | mixed_use | mixed_use ✓ | null ✗ |
| `avaio-taurus-brandon-ms` | mixed_use | mixed_use ✓ | confirmed ✗ |
| `global-ai-windsor-co` | confirmed | confirmed ✓ | mixed_use ✗ |
| `edgecore-mesa-az` | null | mixed_use ✗ | confirmed ✗ |

The rewording hit its target precisely — the "AI & Cloud-Ready Campuses" page it was written for now
abstains correctly — and broke four answers that were already right, three of them by moving a page
across the `confirmed`/`mixed_use` line.

**Why: a tier's definition is not private to that tier.** The new wording asked whether the site
ACTUALLY RUNS more than one workload. But "actually runs" is a criterion `confirmed` was already
using; an AI data center actually runs AI. So instead of sharpening the axis that separates the two
values — one workload versus several — the rewrite made them compete on an axis they share, and the
boundary moved. Editing one enum member's definition silently re-specifies its neighbours.

**Third confirmation of the reallocation rule, in a stronger form than stated.** The README above
says a model reallocates its errors onto whatever values REMAIN when a value is deleted. The
pre-registration bet that narrowing a definition was different in kind. It is not.
`edgecore-mesa-az` has now fabricated under four prompt variants in a row, answering `confirmed`,
then `likely`, then `mixed_use`, then `confirmed` again — every member of the three-value
vocabulary, one after another, on a page whose correct answer is null throughout. It invents
something regardless; the prompt only picks which value it invents. That is a property of the page
and the model, not of the vocabulary.

⚠️ **The label is not the bug — I checked, because this corpus's only two label corrections both
came from the model disagreeing with the labeller.** `edgecore-mesa-az`'s page says "hyperscale
customers' urgent need for AI and cloud-ready capacity", "designed for density", and "support and
scale AI and cloud technology". All three are capability and positioning language about what the
design can serve, with no stated tenant, workload or hardware. `null` is correct, and it matches
TIE-BREAKER 1's own example verbatim. Four disagreements in a row is a page the model cannot read
correctly, not a label to soften.

⚠️ Sample size still bounds everything here: 15 `confirmed` labels, 4 `mixed_use`, 44 `null`. A
four-cell regression is a large share of a small denominator, and this is a single deterministic run
per prompt, not a repeated measurement.

**Where this leaves #214's classification half.** The best measured prompt remains the v1 two-value
field at P=85% / R=89%, still below the pinned bar (`capacityMw.operational` 100/100,
`water.coolingType` 95/95), and still NOT an `ExtractableField`. The next experiment named in the
previous section — a `confirmed`-only run — is unaffected by this result and remains the open lead.
What this run rules out is the cheaper hypothesis that `mixed_use`'s wording alone was the gap.


## aiClassificationConfirmed — a prediction registered before the run

Registered **2026-09-14, BEFORE writing the runner change and before any model call**, per the
discipline this file established twice: once after a prediction was falsified on the
`likely`-removal run, and again in the `mixed_use` rewording section. Nothing below was edited
after seeing a result. If any of it is wrong, it stays on the page.

⚠️ **Provenance note, because it bears on whether this prediction can be trusted.** This section
was written before the run started, then destroyed 8 minutes into that run by my own
`git reset --hard` while realigning a diverged `main` — the backup command I believed had run had
been blocked by a hook, whole, and I did not check before resetting. The text below is restored
verbatim from the session transcript. The RUN ITSELF was unaffected: `run.mjs` reads `truth.json`
and its prompt table at startup, and the process was still alive with both in memory throughout.
The restored `truth.json` produces the same 59 scored cells the in-flight run loaded. The claim
"registered before the run" is true; the file simply had to be rewritten, and that is recorded here
rather than quietly repaired.

### What is under test

A **one-value vocabulary**: `confirmed`, or abstain. This is the experiment the
`aiClassificationStated` section named as the next step, and it exists because that run reported
`confirmed` answered 14 times and correct 14 times — a figure that section explicitly warns must
NOT be read as "ship a confirmed-only extractor at 100%".

### Scoring design, and why it does not blind the experiment

The 4 pages whose true label is `mixed_use` carry **no label** for this field: their correct answer
is not expressible in a one-value vocabulary, and scoring an inexpressible answer as a correct
`null` would credit the prompt for a question it was never asked. Same treatment `likely` already
gets. With `likely` (4), `mixed_use` (4) and `AMBIG` (2) excluded, **59 cells are scored: 15
`confirmed` and 44 `null`.**

⚠️ It is worth being explicit that this exclusion does NOT hide the effect under test. The
reallocation risk is that the 3 pages which drew `mixed_use` errors now answer `confirmed`
instead — and those pages are **true-`null`** pages (marketing copy), which remain scored. The
excluded 4 are the genuinely-mixed_use ones, a different set. The experiment stays sensitive to
exactly the failure it is looking for.

### The prediction

1. **Precision will land between 85% and 95%, and NOT at 100%.** Point estimate **≈90%**.
2. **1 to 3 false `confirmed` on true-`null` pages.** Point estimate **2**.
3. `confirmed` answered **15–18 times**; correct **13–16**.
4. **Recall 87–93%** (13–14 of 15) — at or slightly above the two-value run's 14/15, since no
   competing tier can absorb a true `confirmed`.
5. **Hallucinations 1–3**, against 2 in the two-value run.
6. **The single most falsifiable claim:** `aligned-phx-01-02-03-az` will answer **`confirmed`**.
   It is correctly `null`, it fabricated `mixed_use` in the two-value run on "AI &
   Cloud-Ready Campuses", and with that tier deleted `confirmed` is the only remaining value a
   model inclined to answer can reach for.
7. **Verdict: NOT shippable.** The pinned bar is `capacityMw.operational` at 100/100 and
   `water.coolingType` at 95/95. ~90% does not clear it.

### Where I expect to be wrong, stated in advance

The known prior error **on this exact corpus is OVER-predicting reallocation**: the last
registered prediction said deleting `likely` would push fabrications onto `confirmed`, and instead
6 of 7 abstained correctly and none said `confirmed`.

I am therefore predicting *mild* reallocation (2 pages) rather than the *strong* reallocation that
was predicted and falsified last time. If I am wrong again, the most likely direction is that
reallocation is weaker still — precision at 95–100% with 0–1 false `confirmed`, because
TIE-BREAKER 1 ("capability marketing is NOT a classification ... answer null") gives the model an
explicit, still-present escape route that the deleted tier was competing with.

⛔ **The trap I am deliberately not walking into:** if precision DOES come back at or near 100%,
that is still not licence to ship. n=59 with 15 positive labels is a wide interval, labels remain
single-pass, and this corpus has now demonstrated twice that a restricted vocabulary moves errors
rather than removing them. A clean result here would justify a larger labelled sample, not a
wire-up.

### The result: the prediction was wrong on six clauses of seven

Run 2026-09-14, `result-gpt-oss_20b-aiClassificationConfirmed.json`, 59 scored cells, 10 skipped
and named. **P=100% · R=100% · ABSTENTION-ACC=100% · score 59/59**, quote-grounded 15/15.

`correct=15  correctAbstain=44  miss=0  WRONG=0  HALLUC=0` — zero disagreements across all 59 cells.

| | 3-value, no rule | 3-value + rule | 2-value + rule | **1-value** |
|---|---|---|---|---|
| PRECISION | 56% | 61% | 85% | **100%** |
| RECALL | 43% | 83% | 89% | **100%** |
| WRONG / HALLUC | 3 / 5 | 4 / 8 | 1 / 2 | **0 / 0** |
| score | 33 | 31 | 53 | **59** |

| # | predicted | actual | |
|---|---|---|---|
| 1 | P 85–95%, NOT 100% | 100% | ✗ |
| 2 | 1–3 false `confirmed` | 0 | ✗ |
| 3 | answered 15–18, correct 13–16 | 15 / 15 | ✓ |
| 4 | recall 87–93% | 100% | ✗ |
| 5 | hallucinations 1–3 | 0 | ✗ |
| 6 | `aligned-phx-01-02-03-az` answers `confirmed` | abstained, correctly | ✗ |
| 7 | not shippable at ~90% | clears the bar as measured | ✗ |

**The only clause that held was the one predicting where I would be wrong**: "if I am wrong again,
the most likely direction is that reallocation is weaker still — precision at 95–100% with 0–1
false `confirmed`." That is exactly what happened, which is an argument for registering the
expected failure direction alongside the prediction, not just the prediction.

### What it establishes: reallocation did not happen AT ALL

Both pages that hallucinated `mixed_use` in the two-value run now abstain, and their own
`reasonIfNull` shows why:

- `aligned-phx-01-02-03-az` — *"describes the Phoenix campus as AI-ready and mentions an Advanced
  Cooling Lab for AI/HPC workloads, but it does [not] ..."*
- `edgecore-mesa-az` — *"only describes the Mesa campus as a high-density, AI-ready facility for
  hyperscale customers, but does not expl[icitly] ..."*

That is TIE-BREAKER 1 being applied correctly, on the exact pages that defeated it before.

⇒ **The errors were attached to the `mixed_use` VALUE, not to the model's willingness to answer.**
Removing the value removed the error rather than relocating it.

⚠️ **This materially weakens this README's own "errors reallocate onto whatever values remain"
rule.** That rule was asserted twice as if established. It has now been tested three times and
been weak or absent twice — the three-value→two-value transition (6 of 7 abstained, none said
`confirmed`) and this one (0 of 3). A restricted vocabulary is still not safe to INFER from a wider
run, which was always the defensible half of the claim; but "the model will relocate its
fabrications" is not supported as a prediction rule and should stop being used as one.

### Recommendation: NOT a wire-up yet, and that was decided before the number was known

The pre-registered caveat stands, deliberately — discarding it because the result came back clean
is precisely the failure pre-registration exists to prevent:

> if precision DOES come back at or near 100%, that is still not licence to ship. n=59 with 15
> positive labels is a wide interval, labels remain single-pass ... A clean result here would
> justify a larger labelled sample, not a wire-up.

**n=15 positives.** 15/15 has a 95% lower bound around 78%; this is not a rate pinned at 100%, and
the pinned fields it would join (`capacityMw.operational` 100/100, `water.coolingType` 95/95) carry
the same caveat about interval width.

**Next step, in order:** expand the labelled positive set to ~40+ `confirmed` pages drawn from
outside the current 69, re-run this exact field, and only then consider adding
`aiClassificationConfirmed` to `ExtractableField` with a drift test pinning the prompt the way
`coolingType` has one. ⛔ Do not wire it off this run.

⚠️ Note what shipping this field would and would not give the dataset: a `confirmed`-or-nothing
extractor cannot express `mixed_use` or `likely` at all. That matches how the data model already
treats absence as meaningful, but it means the lane would never populate the other two enum members
— those stay hand-curated. Decide that deliberately rather than discovering it later.
