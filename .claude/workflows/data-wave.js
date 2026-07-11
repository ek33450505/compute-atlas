// Usage: Workflow({ name: 'data-wave', args: {
//   state: 'Ohio', stateAbbr: 'OH',
//   focusHint: 'favor traditional/colo, non-AI-classified facilities',
//   existingFacilities: [{name, operator, city}, ...]   // required — script has no filesystem access,
//                                                        // so compute this from data/facilities.json
//                                                        // before invoking, e.g.:
//   // python3 -c "import json; d=json.load(open('data/facilities.json'));
//   //   print(json.dumps([{'name':f['name'],'operator':f['operator'],'city':f['location'].get('city')}
//   //   for f in d if f['location']['state']=='OH']))"
// }})
//
// Stops before commit/push — the main session reads the diff and review verdict, then ships.

export const meta = {
  name: 'data-wave',
  description: 'Discover, verify, and write new Compute Atlas facility candidates for a target state',
  whenToUse:
    'Extend or backfill state coverage for the ai-datacenter-tracker (Compute Atlas) dataset. Reuses docs/track-c-candidate-ledger.md as a cross-wave candidate cache instead of rediscovering leads from scratch each run.',
  phases: [
    { title: 'Discovery', detail: 'read candidate ledger, cross-check existing facilities, fresh web discovery' },
    { title: 'Verify', detail: 'independent per-batch verification with real source citations' },
    { title: 'Write', detail: 'insert schema-valid records into data/facilities.json' },
    { title: 'Review', detail: 'code-reviewer pass on the diff' },
  ],
}

const REPO = '/Users/edkubiak/Projects/personal/ai-datacenter-tracker'
const { state, stateAbbr, focusHint, existingFacilities } = args || {}

if (!state || !stateAbbr || !existingFacilities) {
  throw new Error(
    'data-wave requires args: {state, stateAbbr, existingFacilities}. See usage comment at top of this file.'
  )
}

const CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          operator: { type: 'string' },
          city: { type: 'string' },
          county: { type: 'string' },
          facilityTypeGuess: { type: 'string', enum: ['data_center', 'crypto_mining'] },
          notabilityNote: { type: 'string' },
          docDepthGuess: { type: 'string', enum: ['strong', 'moderate', 'thin'] },
        },
        required: ['name', 'operator', 'facilityTypeGuess', 'notabilityNote'],
      },
    },
  },
  required: ['candidates'],
}

phase('Discovery')
log(`Data wave: ${state} (${stateAbbr})`)

const discovery = await agent(
  `You're doing discovery research for the "Compute Atlas" data center tracker (repo: ${REPO}), which tracks US data centers of ANY type (AI/hyperscale, traditional enterprise/colo, crypto-mining).

Target: ${state} (${stateAbbr}). ${focusHint ? 'Steer: ' + focusHint : ''}

STEP 1 — Read ${REPO}/docs/track-c-candidate-ledger.md (Read tool) if it exists. This is a cross-wave discovery ledger from prior sessions — a markdown table of candidate facilities with a State (ST) column, some rows marked (INTAKEN) (already added to the dataset) and some not. Filter to rows where ST = "${stateAbbr}" and NOT marked (INTAKEN) — these are free leads from prior research you can verify without rediscovering them.

STEP 2 — Cross-check against facilities already tracked for this state (do NOT re-suggest these):
${existingFacilities.map((f) => `- ${f.name} (${f.operator})${f.city ? ', ' + f.city : ''}`).join('\n')}

STEP 3 — Do a broad fresh web discovery pass for anything not already covered by the ledger or the existing-facilities list above: major colo/enterprise operators (CyrusOne, QTS, Vantage, Digital Realty, Equinix, NTT, DataBank, Involta/Ark Data Centers, Sabey, T5 Data Centers), hyperscalers (Google, Meta, Microsoft, AWS, Oracle, OpenAI/Stargate), and crypto-mining operators (Bitdeer, TeraWulf, Cipher Mining, Core Scientific, Marathon, IREN, Riot). Aim for a combined total (ledger leads + fresh finds) of 8-15 candidates.

STEP 4 — Append any genuinely NEW candidates (not already in the ledger) to ${REPO}/docs/track-c-candidate-ledger.md as new table rows, following the file's existing table format and column order, under a new dated subsection header for this wave. Create the file with a matching header structure if it doesn't exist yet. This keeps the ledger useful for future waves regardless of what happens next in this run.

Return your full candidate list (ledger leads + fresh finds combined) via the required schema.`,
  { label: `discovery:${stateAbbr}`, phase: 'Discovery', schema: CANDIDATE_SCHEMA, agentType: 'researcher' }
)

const candidates = discovery?.candidates || []
log(`${candidates.length} candidates found for ${stateAbbr}`)

if (candidates.length === 0) {
  return { state, stateAbbr, candidates: [], message: 'No candidates found — nothing to verify or write.' }
}

phase('Verify')
const BATCH_SIZE = 3
const batches = []
for (let i = 0; i < candidates.length; i += BATCH_SIZE) batches.push(candidates.slice(i, i + BATCH_SIZE))

const verifyResults = await parallel(
  batches.map((batch, i) => () =>
    agent(
      `You're doing independent verification for the "Compute Atlas" data center tracker (repo: ${REPO}). A discovery pass surfaced these candidates for ${state} (${stateAbbr}) — verify each independently (don't just repeat the claims), find real working source URLs (prefer primary/operator sources and SEC filings; note when a claim is single-sourced or aggregator-only), and resolve exact city/county — DO NOT recommend adding a facility whose city/county cannot be confirmed.

Candidates in this batch:
${batch.map((c) => `- ${c.name} (${c.operator}), ${c.city || 'city unknown'} — ${c.notabilityNote}`).join('\n')}

For each: report facilityType (data_center/crypto_mining), whether it warrants an aiClassification field per lib/schema.ts's enum (confirmed/likely/mixed_use — only if there's real evidence of AI/HPC/GPU-specific marketing, not generic "cloud" language), status, capacity in MW (planned/operational, only if disclosed — do not guess), investment/acreage/jobs if disclosed, city/county/address as precise as available, community/legal/moratorium context if any, and a full source list (url, label, publisher, kind: press/permit/osm/iso_queue/subsidy/filing/other, what it confirms).

End with a clear verdict per candidate: ADD AS-IS, ADD WITH CORRECTIONS (list them), or DROP (explain why — e.g. unconfirmed location, decommissioned, misattributed operator, duplicate of an existing tracked facility).`,
      { label: `verify:${stateAbbr}:batch${i}`, phase: 'Verify', agentType: 'researcher' }
    )
  )
)

log(`Verification complete for ${batches.length} batch(es)`)

phase('Write')
const WRITE_GROUP_SIZE = 2 // ~2 verify-batches (~6 candidates) per write agent, matching the proven manual split
const verifyChunks = []
for (let i = 0; i < verifyResults.length; i += WRITE_GROUP_SIZE) {
  const chunkText = verifyResults
    .slice(i, i + WRITE_GROUP_SIZE)
    .filter(Boolean)
    .join('\n\n---\n\n')
  if (chunkText) verifyChunks.push(chunkText)
}

const writeResults = await parallel(
  verifyChunks.map((chunk, i) => () =>
    agent(
      `Repo: ${REPO}. File: data/facilities.json — a top-level JSON array of facility objects validated by lib/schema.ts (Zod). Do NOT run \`npm run build\`/\`next build\` (a dev server may be running); use \`npx tsc --noEmit\` and \`npx vitest run\` to validate instead.

Below is verified research for ${state} (${stateAbbr}) facility candidates. For every candidate with a verdict of ADD AS-IS or ADD WITH CORRECTIONS, read lib/schema.ts first to confirm the exact shape/enums, then compose a schema-valid facility object and append it to the END of the data/facilities.json array. Skip anything verdicted DROP.

NOTE: other write agents may be concurrently appending to this same file — before you write, RE-READ the file's current tail to get correct insertion syntax; if your edit attempt fails with a "modified since read" error, just re-read and retry.

Use id format: lowercase-kebab-slug ending in the state abbreviation (must match regex ^[a-z0-9-]+$; grep the file first to avoid collisions). Use "lastUpdated": "2026-07-10" and "retrievedAt": "2026-07-10" for all new entries. Set "precision": "approximate" on location unless a source gives an exact parcel-confirmed point. Only set capacityMw/investmentUsd/landAcres/jobs fields when a source actually discloses them — never guess a number.

Also: for each candidate you add, find its row in ${REPO}/docs/track-c-candidate-ledger.md (if present) and mark it (INTAKEN) following the file's existing convention.

VERIFIED RESEARCH:
${chunk}

After inserting: validate the file is valid JSON, run \`npx tsc --noEmit\`, and run \`npx vitest run\`. Fix any schema violations ONLY in what you just added — do not touch unrelated existing records. Do NOT commit. Report exactly what you inserted (ids + names) and what you dropped (with reasons), plus the final test/typecheck results.`,
      { label: `write:${stateAbbr}:chunk${i}`, phase: 'Write', agentType: 'code-writer' }
    )
  )
)

phase('Review')
const review = await agent(
  `Repo: ${REPO}. Review the uncommitted working-tree diff in data/facilities.json (run \`git diff data/facilities.json\`) — it should contain only new facility records for ${state} (${stateAbbr}), plus possible (INTAKEN) markers in docs/track-c-candidate-ledger.md. Check schema conformance against lib/schema.ts (Zod), sourceIndex bounds, duplicate IDs, internal consistency between notes and structured fields, and convention consistency with neighboring records. Run \`npx vitest run\` and \`npx tsc --noEmit\` yourself and treat any regression as blocking. Report BLOCK / concerns / clean with specifics.`,
  { label: `review:${stateAbbr}`, phase: 'Review', agentType: 'code-reviewer' }
)

return {
  state,
  stateAbbr,
  candidatesFound: candidates.length,
  writeResults: writeResults.filter(Boolean),
  review,
  nextSteps: 'Not committed or pushed. Main session should read the diff, confirm the review is clean, then commit + push.',
}
