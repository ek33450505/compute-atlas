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

## Why this is version-controlled

This directory is the calibration evidence behind the shipped Track 5 tool's
(`scripts/discovery/extract-fields.ts`) headline claim — PRECISION 90% / RECALL
84% / ABSTENTION-ACC 96%, reproduced by `rescore.mjs` against 31 real cached
pages. A claim like that is only worth anything if the harness that produced it
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
