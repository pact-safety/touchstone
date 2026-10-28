# Bake-off against BetterBench, 2026-10-28

Each model assessed the benchmarks BetterBench scored by hand; its verdicts are compared with BetterBench's. Agreement, MAE and kappa use only items where both gave a number; n/a is counted separately.

Excerpt budget: 40000 characters per group.

| | qwen/qwen3.6-35b-a3b | google/gemma-4-31b-it |
|---|---|---|
| items compared (missing) | 1021 (60) | 1020 (61) |
| numeric items | 987 | 983 |
| exact agreement % | 56.4 | 56.5 |
| within 5 points % | 72.0 | 73.7 |
| MAE (points) | 4.60 | 4.37 |
| quadratic kappa | 0.408 | 0.456 |
| kappa 95% CI | [0.353, 0.458] | [0.405, 0.504] |
| MAE 95% CI | [4.26, 4.95] | [4.03, 4.72] |
| exact % 95% CI | [53.0, 59.5] | [53.0, 59.9] |
| bias (model − gold, points) | -0.88 | -1.67 |
| kappa vs top (95% CI) | [-0.098, 0.002] | — |
| n/a: both / gold only / model only | 0 / 34 / 0 | 0 / 37 / 0 |
| overall score mean abs diff | 2.06 | 2.57 |
| quote checks failed | 121 / 816 | 38 / 577 |
| verdicts downgraded (no quote) | 80 | 38 |
| pairs complete / incomplete | 23 / 0 | 23 / 0 |
| calls | 92 | 92 |
| input tokens | 709191 | 715200 |
| output tokens | 114252 | 72086 |
| cost ($) | 0.1795 | 0.1719 |
| providers | DeepInfra | DeepInfra |

The 95% CIs resample benchmarks (2000 draws, fixed seed), not items, because items within a benchmark are not independent; "kappa vs top" is the CI of the difference from the highest-kappa model on the same resamples.

## Items with the most disagreement

| benchmark | item | BetterBench | qwen/qwen3.6-35b-a3b | google/gemma-4-31b-it | total abs diff |
|---|---|---|---|---|---|
| agentbench | imp.07 | 0 | 15 | 15 | 30 |
| ale | imp.11 | 15 | 0 | 0 | 30 |
| ale | mai.01 | 15 | 0 | 0 | 30 |
| ale | mai.02 | 15 | 0 | 0 | 30 |
| ale | mai.03 | 15 | 0 | 0 | 30 |
| arc-challenge | des.11 | 15 | 0 | 0 | 30 |
| arc-challenge | doc.01 | 15 | 0 | 0 | 30 |
| arc-challenge | doc.12 | 15 | 0 | 0 | 30 |
| arc-challenge | imp.04 | 15 | 0 | 0 | 30 |
| arc-challenge | mai.01 | 15 | 0 | 0 | 30 |
