# Touchstone

Rigor ratings for AI benchmarks, across the published standards for what makes a benchmark good. Live at **[touchstone.pact-safety.dev](https://touchstone.pact-safety.dev)**.

People cite benchmark results to back claims about AI models, and benchmarks differ a great deal in how carefully they were built. Several groups have published standards for what makes a benchmark good: the AI Standards Lab Scorecard, BetterBench, the Agentic Benchmark Checklist, the construct-validity checklist from *Measuring What Matters*, STREAM and others. Each covers different things and uses its own scale. Touchstone encodes those standards as data, applies them to each benchmark with cited evidence, and shows the verdicts side by side, so a reader can see how rigorous a benchmark is and where the standards disagree.

**Status.** The published ratings so far are imports from the standards' own authors. The 307 automated assessments are unreviewed drafts produced by google/gemma-4-31b-it; they are shown labelled as drafts and never count toward a score.

## Principles

- **Judgement and arithmetic are separate.** People, or an open-weights model whose work people review, decide one verdict per item. Scores are a deterministic function of the verdicts ([`src/engine.ts`](src/engine.ts)); the verdicts themselves are judgements. The same verdicts always give the same score, and every score carries a plain-language explanation of how it was calculated.
- **Every positive verdict cites evidence** at a pinned version (an arXiv version or a git commit), with an exact location and a short quote. Missing documentation counts as not met.
- **Standards are encoded as written.** Item wording is the standard's own; each item adds a decision rule. Where a standard publishes no scoring rule, Touchstone's rule is marked as such.
- **Ratings are kept current.** A job checks every benchmark's paper and repository, re-assesses what changed with an open-weights model, verifies every quote it gives against the source, and opens a pull request for human review. It is run manually for now; scheduling is paused.
- **Anyone can challenge a rating.** Each verdict has a "Request a correction" link. Accepted changes are pull requests with a revision entry linking the request.

## What's here

| Path | Contents |
|---|---|
| `standards/` | Each standard as data: items, decision rules, severities, scoring rule |
| `data/benchmarks/` | Benchmarks and their paper and repo links |
| `data/assessments/<benchmark>/<standard>.yaml` | Reviewed or externally published assessments |
| `data/assessments/<benchmark>/<standard>.auto.yaml` | Model-proposed assessments (drafts until reviewed) |
| `data/runs/` | Transcripts of every automated run |
| `data/sources/` | Snapshots of external assessments that were imported |
| `src/` | Schema, scoring engine, validator, assessor, source watcher, triage |
| `site/` | The website (TypeScript, Tailwind) |
| `prompts/` | The versioned prompt the assessor uses |
| `config/models.yaml` | The allowlist of open-weights models |

## Commands

```bash
npm ci
npm run check                                   # typecheck, validate every file, run tests
npm run dev                                     # site at http://localhost:5173
npx tsx src/cli.ts watch                        # what changed upstream, and what would be re-assessed
npx tsx src/cli.ts assess --benchmark truthfulqa --standard aisl-scorecard
npx tsx src/cli.ts replay --benchmark truthfulqa --standard aisl-scorecard
```

See [docs/methodology.md](docs/methodology.md) for the scoring rules, [docs/touchstone-score.md](docs/touchstone-score.md) for the Touchstone score (rigor consensus and run cost), [docs/automation.md](docs/automation.md) for the re-assessment job and auditing, and [CONTRIBUTING.md](CONTRIBUTING.md) for corrections and new assessments.

## Current data

48 benchmarks, 9 encoded standards and 2 catalogued. There are 35 published assessments, all imported from the standards' authors: BetterBench (23 benchmarks, item level), the Agentic Benchmark Checklist (10, section scores) and the AI Standards Lab Scorecard (2 worked examples). Recomputing them from their own verdicts flags where published figures disagree: 10 BetterBench entries, and ImpossibleBench, which the Scorecard paper rates Category B under an earlier version of its table but which scores Category C under the final one.

There are also 307 automated drafts, not yet reviewed (see Status above).

## Licence

Code and Touchstone's own data: MIT. Imported assessments remain their authors' work and are cited to their sources.

## How to cite

See [`CITATION.cff`](CITATION.cff). GitHub shows a "Cite this repository" button from it.
