## What changed

<!-- Which assessments, standards or code, and why. -->

## For changes to verdicts or scores

- [ ] Each changed assessment has a new `revisions` entry listing every changed item, with `request: <issue number>` if it answers a correction request
- [ ] Every changed positive verdict cites evidence at a pinned version (arXiv vN, or a commit SHA)
- [ ] `npx tsx src/cli.ts validate` and `npm test` pass

## For changes to a standard's encoding

- [ ] Item wording still matches the standard verbatim
- [ ] `version` is bumped if any decision rule changed meaning
