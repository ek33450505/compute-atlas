## What this changes

<!-- A short summary of the change and why. Link a related issue with "Closes #123". -->

## Type

- [ ] Data — add or correct facility records
- [ ] Code — feature, fix, or refactor
- [ ] Docs / chore

## Checklist

- [ ] I read [CONTRIBUTING.md](https://github.com/ek33450505/compute-atlas/blob/main/CONTRIBUTING.md).
- [ ] **Every new or changed fact has a public, verifiable source URL.** _(data)_
- [ ] Confidence is honest — announced-but-unbuilt sites are `proposed`/`permitted`, not `under_construction`. _(data)_
- [ ] `npm run typecheck`, `npm run lint`, and `npm run test` pass. _(code)_
- [ ] The data-integrity suite (`lib/data-integrity.test.ts`) passes over `data/facilities.json` — every record valid against the schema. _(data)_
- [ ] Changes are additive where possible; no existing records dropped.

## Notes for the reviewer

<!-- Anything that needs context: sources you leaned on, decisions you weren't sure about, screenshots for UI changes. -->
