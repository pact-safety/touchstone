# Contributing

## Request a correction

If a verdict or score is wrong or missing information, use **Request a correction** next to the item on the site, or open a [score correction issue](../../issues/new?template=score-correction.yml). Name the items and link evidence at a specific version (an arXiv version, or a file at a commit). An automated comment lists the current verdicts for those items.

A maintainer then checks the evidence against each item's decision rule (`guidance.met` in the standard's file). If it holds, the change is made in a pull request that:

- updates the verdict with `by: human`, a rationale and the evidence;
- appends a `revisions` entry listing every changed item, with `request: <issue number>`.

CI rejects any change to verdicts without such an entry (`touchstone check-revisions`). Benchmark authors are welcome to file requests; say so in the form, and expect the same evidence standard as anyone else.

Imported assessments (`provenance.kind: external`) record what another group published. Touchstone does not change their verdicts. A correction to one is filed with its source, or answered with a Touchstone assessment of the same pair.

## Assess a benchmark

1. Add `data/benchmarks/<id>.yaml` with paper and repo links.
2. Run `npx tsx src/cli.ts assess --benchmark <id>` to get model-proposed drafts, or write `data/assessments/<id>/<standard>.yaml` by hand.
3. A Touchstone assessment needs two independent assessors before `status: published`. So far, all published assessments are imports from the standards' authors; Touchstone's own automated assessments are drafts awaiting review.

## Encode a standard

Add `standards/<id>.yaml` with `status: encoded`. Copy item wording verbatim; write a `guidance.met` rule for every item that a second person could apply and reach the same verdict; give `not_applicable` only where the standard allows it. If the standard publishes no scoring rule, use `checklist` and set `scoring_defined_by: touchstone`.

## Checks

```bash
npm run check
```
