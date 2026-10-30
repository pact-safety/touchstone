# The Touchstone score

Each benchmark gets two separate things, shown side by side and never blended into one number:

1. **Rigor consensus**: how rigorous the benchmark is, according to the published standards it has been rated under.
2. **Run cost**: what a full run of the benchmark takes.

A third view, the **value frontier**, compares the two across benchmarks. Everything here is deterministic arithmetic over the repository's data; the code is in `src/touchstone.ts` and the reference prices are in `config/pricing.yaml`.

## Why the parts are never blended

A cheap benchmark should not look more rigorous, and a rigorous one should not look cheap. If cost were folded into a single score, a benchmark could gain rank by being easy to run, and a reader could not tell which of the two they were looking at. So the site shows a grade for rigor and tiers for cost, and leaves the trade-off to the reader.

## Part 1: Rigor consensus

**Which ratings count.** For each encoded standard, one assessment is chosen:

- Only assessments with `status: published` count. Drafts are excluded from the score.
- Among the published assessments for that standard, prefer provenance `touchstone`, then `external`, then `automated`.

Each chosen assessment is scored by the engine (`score()` in `src/engine.ts`) and put on a 0 to 100 scale:

| Standard's scheme | Normalized value |
| --- | --- |
| `aisl-severity` | Category A = 100, B = 80, C = 60, D = 40, E = 20, Unclassified = 0 |
| `points` or `checklist` | the overall percent of the result |
| any result that is Incomplete, or has no percent | not counted |

**Score.** The median of the counted values, rounded to one decimal. For an even count it is the mean of the two middle values. Putting different standards on one 0–100 scale is a display convention, not a validated measure.

**Grade.** A if the score is 85 or more, B at 70, C at 55, D at 40, E at 25, otherwise F. With no counted values there is no grade.

**Spread.** Highest minus lowest counted value.

**Agreement.** `single` with one standard. Otherwise `high` if the spread is 15 or less, `moderate` if 30 or less, else `low`.

**Confidence.**

- `high`: three or more standards and agreement is high or moderate.
- `medium`: two standards and agreement is not low, or three or more standards with low agreement.
- `low`: everything else (no standard, one standard, or two that disagree widely).

**Grade stability.** The grade is "stable" when it is the same with every cutpoint shifted down by 5 and up by 5 (for example, with the A to F cuts at 80, 65, 50, 35, 20 and again at 90, 75, 60, 45, 30). A grade that is not stable sits close to a boundary, and the site says so.

### Worked example

A benchmark is rated under three standards: BetterBench gives 61, the Agentic Benchmark Checklist gives 72, and the AI Standards Lab Scorecard gives Category C, which normalizes to 60.

- Counted values: 61, 72, 60. Sorted: 60, 61, 72. The median is **61**.
- 61 is at least 55 but below 70, so the grade is **C**.
- Spread is 72 − 60 = 12, which is 15 or less, so agreement is **high**. With three standards, confidence is **high**.
- Shifting every cut down by 5 puts the C cut at 50 (61 is still C); shifting up by 5 puts it at 60 (61 is still C, and the B cut is 75). The grade is **stable**.

The site shows: "Median of 3 standards (BetterBench 61, ABC 72, AISL 60) = 61 → C. Spread 12 → high agreement; confidence high."

### Why these choices

- **Median, not mean.** One outlier standard (a very strict or very lenient one) cannot drag the result. With only two standards the median equals the mean.
- **Uniform cutpoints.** The same grade cuts apply to every benchmark, so grades are comparable and nobody can tune a boundary to a particular result.
- **The stability check.** Any cutpoint is somewhat arbitrary. Showing whether a small shift would change the grade tells readers when a grade is a firm call and when it is a coin toss at the edge.

## Part 2: Run cost

Read from a benchmark's `resources` record (see `Resources` in `src/schema.ts`). Counts come from the benchmark's own paper, docs or repository, each with a citation. A benchmark with no record shows "Run-cost data not yet collected".

**Tokens per full run** = items × (model calls per item + judge calls per item) × tokens per call.

**API tier** from the token count: `$` under 1 million, `$$` under 10 million, `$$$` under 100 million, `$$$$` under 1 billion, `$$$$$` otherwise. Benchmarks that do not call a language model (`non-llm`) have tier `none`.

**Cost range** = tokens ÷ 1 million × the low and high reference price, rounded to two significant figures; 0 to 0 for non-LLM benchmarks. The reference prices are a band, not quotes: the low end is a small open-weights model on a low-cost hosted provider, the high end a frontier proprietary model. They carry an "as of" date.

**Local tier**, for the harness only. It does not include hosting the model under test. The first rule that matches applies:

1. **Extreme**: more than 500 GB of disk, or a `vm` environment with more than 500 items.
2. **Heavy**: the harness needs a GPU, or a `vm` environment, or more than 50 GB of disk.
3. **Standard**: a `docker`, `simulator` or `live-web` environment, more than 5 GB of disk, or agentic interaction.
4. **Lite**: otherwise.

## Part 3: Value frontier

A benchmark is on the frontier ("Best value") when it has both a rigor score and a token count, and no other benchmark has a score at least as high and tokens at most as high with at least one of the two strictly better. Non-LLM benchmarks have no token count and are left out. The frontier is a filter for finding good value, not a ranking.

## Known limitations

- **Different standards on one 0 to 100 scale.** Normalizing assumes the standards' scales are comparable, which is not proven. The calibration plan is to publish pairwise Spearman correlations between standards once at least 10 benchmarks have two or more standards.
- **Drafts are excluded.** An automated assessment counts only after a person has reviewed and published it, so benchmarks with only drafts have no score yet.
- **Token figures are estimates.** Tokens per call is an estimate whose basis is stated in each record; real runs vary with the model, prompts and retries.
- **The local tier excludes model hosting.** It says what the harness needs, not what it takes to run the model being tested, which is often the larger cost.
- **Few standards.** With one or two standards the score has low or medium confidence by design.
