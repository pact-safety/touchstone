# Roadmap

Ranked by value to the three groups who rely on benchmarks, against the effort to build. "Built" items shipped on 2026-10-26.

| # | Feature | Who it helps | Why | Effort | Status |
|---|---|---|---|---|---|
| 1 | **What would most improve this rating.** For each assessment, the unmet items whose fix would most raise the score, with the exact effect ("cv.01: Construct validity Invalid → 1; overall Unclassified → Category C") | Benchmark authors | Turns a grade into a to-do list. Computed by re-scoring, so it is exact, not advice | Small | Built |
| 2 | **Safety benchmark coverage.** HarmBench, WMDP, StrongREJECT, XSTest, AgentHarm and others in the dataset, assessed nightly | Everyone | The benchmarks most cited in safety claims were missing | Small | Built |
| 3 | **Fitness-for-use filter.** "Show benchmarks fit for policy decisions (AISL Category B or better)", "fit for a model card claim (C or better)" | Policymakers, model developers | Answers the question people actually ask: can I rely on this for my decision? | Small | Next |
| 4 | **Model-card check.** Paste a model card or system card; get every benchmark it cites with its ratings and fitness for the claim made | Policymakers, auditors | Connects ratings to the claims they underpin | Medium | Next |
| 5 | **Badges and embeds.** `badge/<benchmark>/<standard>.svg` linking to the rating, for benchmark READMEs and papers | Benchmark authors | Makes rigor visible where benchmarks are chosen; an incentive to improve | Small | Next |
| 6 | **Pre-release self-check.** A GitHub Action and CLI (`touchstone assess --paper <pdf> --repo .`) that benchmark authors run in their own CI before publishing | Benchmark authors | Catches problems before release, when they are cheapest to fix | Medium | Later |
| 7 | **Assessor agreement metrics.** Run two models (or a model and a person) on the same pair; publish Cohen's kappa per standard and per item | Everyone | Measures the tool's own reliability instead of asserting it; finds rules that still need sharpening | Medium | Later |
| 8 | **Compare view.** Two or more benchmarks of the same construct side by side, item by item (e.g. HarmBench vs StrongREJECT) | Model developers | Helps choose between benchmarks measuring the same thing | Medium | Later |
| 9 | **Repository probes.** Deterministic checks of a benchmark's code (pinned dependencies, seeds, held-out split or canary, oracle solver, state reset) supplying evidence for items that name a `probe` | Everyone | Moves code-checkable items from model judgement to mechanical fact | Medium | Later |
| 10 | **Change feed.** RSS/JSON feed and a weekly digest of rating changes and new corrections | Followers, journalists | Ratings that move should be noticed | Small | Later |
| 11 | **Encode remaining standards.** NIST AI 800-2 (as evaluator-practice items), Yu et al. 2026 safety checklist, Deprecation criteria | Everyone | More standards, more perspectives on each benchmark | Medium each | Later |

## Reliability work still open

- Rules: the 2026-10-26 audit flagged 81 of 154 decision rules as open to interpretation; they were sharpened the same day, but agreement has not yet been measured (item 7).
- Model: the nightly default (qwen3:8b on a CPU runner) was chosen to fit a free runner. Stronger open models (gpt-oss-20b/120b) need a larger or self-hosted runner, or a hosted OpenAI-compatible provider with a key.
- Quote verification proves a quote exists in the source, not that it supports the verdict. Human review of nightly pull requests remains the safeguard.
