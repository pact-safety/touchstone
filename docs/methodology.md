# Methodology

## Terms

- **Standard**: a published framework for judging benchmark quality, encoded in `standards/<id>.yaml`.
- **Group**: a standard's dimension or section (e.g. *Internal validity*, *Task validity*).
- **Item**: one requirement within a group. Leaf items are scored; a `principle` above them is context only.
- **Verdict**: an assessor's decision on one item: `met`, `unmet` or `n/a`, or a level for points-based standards.
- **Assessment**: all verdicts for one benchmark under one standard, with provenance and a revision log.

## Encoding a standard

Each item keeps the standard's wording verbatim in `text` and adds `guidance`:

- `met`: the decision rule. The item is met only when this is true of the cited evidence.
- `not_applicable`: when the item may be `n/a`. Items without it can never be `n/a`.
- `evidence`: which kinds of source can satisfy it.
- `probe` (planned): an automated repository check that can supply evidence.

A change that alters what a rule means bumps the standard's `version`. Assessments pin `standard_version`, and the nightly job re-assesses pairs whose standard was revised.

## Verdict rules

1. Absence of documentation is `unmet`. An assessor may not infer what a paper does not say.
2. A positive verdict cites at least one piece of evidence at an immutable reference (arXiv `vN`, commit SHA, dataset revision), with a locator (section, page, or file and lines) and, where possible, a quote of at most ~40 words.
3. A negative verdict cannot quote an absence, so it needs a rationale naming what was looked for.
4. `n/a` needs a rationale naming the item's n/a condition.
5. Published assessments by Touchstone need two independent assessors. Automated assessments need at least one human reviewer before they are published.
6. A missing verdict is scored as `unmet`.

Disputed cross-check rows are settled by a fixed rule cascade, not by opinion: see [`adjudication.md`](adjudication.md).

## Scoring schemes

All arithmetic is in [`src/engine.ts`](../src/engine.ts). Values are rounded half up to one decimal only for display and comparison.

**AISL severity** (AI Standards Lab Scorecard). Each item has a severity taken from its highlight colour in the published template. Per dimension:
- any unmet `baseline` item: the dimension is **invalid**;
- otherwise the score is 1, raised to 2, 3 or 4 by the worst unmet `yellow`, `orange` or `red` item.

The benchmark gets the first category, A to E, whose per-dimension limits every dimension meets. If any dimension is invalid or unscored, or no category fits, it is *Unclassified*.

**Points** (BetterBench). Each criterion is 0, 5, 10 or 15. A stage's score is the mean of its applicable criteria; the overall score is the mean of all applicable criteria. This reproduces BetterBench's published scores wherever its published criterion scores agree with its published stage scores.

**Checklist** (ABC, construct validity, STREAM). A group's score is met ÷ (met + unmet) × 100; the overall score is the mean of group scores. This reproduces every published ABC overall score. For the construct-validity checklist and STREAM, which publish no scoring rule, it is Touchstone's rule and marked `scoring_defined_by: touchstone`.

## Imported assessments

Where a standard's authors published assessments, they are imported with `provenance.kind: external`. Item-level verdicts are imported where published (BetterBench); otherwise only group scores (ABC, AISL worked examples). The figures the source published are kept under `published`, and the engine flags any that differ from a recomputation by more than 0.1. A flag is information, not an accusation: it usually means a source revised its criteria or its table after scoring.

## Comparing standards

Standards measure different things on different scales. Touchstone never merges them into one number. The site's bars place a score on its own standard's scale (AISL 1→100%, 4→0%; points ÷ 15; checklists as percentages; categories A→100% … E→0%) for visual length only.

## Rule revisions

**2026-10-26.** The `guidance.met` (and, for a few items, `guidance.not_applicable`) decision rules of 81 items were rewritten so that two assessors reach the same verdict: each now names the observable evidence required. Standards changed: `aisl-scorecard` (34 rules, now 2026.07.1), `abc` (25, now 1.0.1), `construct-validity` (15, now 2025.1.1) and `stream` (7, now 1.0.1). Item wording and severities are unchanged.
