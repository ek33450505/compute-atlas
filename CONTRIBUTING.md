# Contributing to Compute Atlas

Thank you for helping map the U.S. grid-scale compute buildout. Compute Atlas is a community-stewarded, public-interest dataset, and it gets more useful every time someone adds a missing facility or corrects a record.

This guide covers how to contribute data and code, and the standard the dataset is held to.

## The one rule: a public source for everything

**Every fact needs a public source URL that anyone can verify.** This is the core principle of the project — a permit filing, a utility interconnection document, a company announcement, a subsidy disclosure, or credible reporting. Submissions without a verifiable source can't be accepted, no matter how confident they sound.

## Ways to contribute

### 1. Suggest a new facility

Use the **[New facility issue form](https://github.com/ek33450505/compute-atlas/issues/new/choose)**. You'll be asked for the facility name, operator, location, status, and — required — at least one public source URL. You don't need every field; partial records with a good source are welcome and get deepened over time.

### 2. Submit a correction

Use the **[Correction issue form](https://github.com/ek33450505/compute-atlas/issues/new/choose)**. Identify the facility (name or slug, e.g. `xai-colossus-memphis-tn`), the value that's wrong, and the corrected value **with a source URL**.

### 3. Contribute code or a data pull request

For code changes or larger data additions, open a pull request. See the [README](README.md#local-development) for local setup. Before opening a PR:

- Run `npm run typecheck`, `npm run lint`, and `npm run test`.
- For data changes, run `npm run build` — it validates every record against the Zod schema in `lib/schema.ts` and fails loudly on any malformed or missing field.
- Keep data changes additive where possible; never drop existing records.

## The data standard

Records are held to a deliberate bias against fabrication. When adding or editing data:

- **Cite the source.** Every record carries at least one source with a `url`, `label`, `kind`, and `retrievedAt` date.
- **Be honest about confidence.** Mark records `confirmed`, `reported`, or `rumored`. If a site is announced but unbuilt, its status should say so (`proposed` / `permitted`), not `under_construction`.
- **Numbers only when firm.** Ranges, ceilings, and modeled projections belong in a record's notes — not in a numeric field. A multi-year subsidy total is described in the program label, not asserted as one dollar figure. Being *eligible* for an incentive is not the same as receiving an award; don't record it as one.
- **Prefer primary sources.** Trackers and aggregators are useful leads, but verify against the underlying filing or announcement before recording.

## What happens after you submit

Compute Atlas follows an **open output, curated intake** model: the data and code are fully open, but every submission is reviewed against its sources before it enters the dataset. This keeps the atlas trustworthy. Please don't be discouraged if a record is held for verification or adjusted for confidence — that review *is* the value of the project.

> Contributions are currently intaken through GitHub issue forms. A dedicated in-app submission form feeding a private moderation queue is planned; when it ships, these forms will be repointed to it. Until then, the issue forms are the way in.

## Code of Conduct

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By contributing, you agree to uphold it.

## License

By contributing, you agree that your contributions will be licensed under the project's licenses: [MIT](LICENSE) for code and [CC BY 4.0](LICENSE-DATA) for data.
