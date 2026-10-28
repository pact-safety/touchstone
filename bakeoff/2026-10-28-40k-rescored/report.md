# Bake-off against BetterBench, 2026-10-28

Each model assessed the benchmarks BetterBench scored by hand; its verdicts are compared with BetterBench's. Agreement, MAE and kappa use only items where both gave a number; n/a is counted separately.

Excerpt budget: 40000 characters per group.

| | qwen/qwen3.6-35b-a3b | google/gemma-4-31b-it |
|---|---|---|
| items compared (missing) | 1021 (60) | 1020 (61) |
| numeric items | 987 | 983 |
| exact agreement % | 54.5 | 57.6 |
| within 5 points % | 70.2 | 74.0 |
| MAE (points) | 4.81 | 4.29 |
| quadratic kappa | 0.384 | 0.464 |
| kappa 95% CI | [0.327, 0.435] | [0.405, 0.517] |
| MAE 95% CI | [4.45, 5.21] | [3.93, 4.67] |
| exact % 95% CI | [50.6, 58.1] | [54.3, 60.5] |
| bias (model − gold, points) | -1.12 | -1.69 |
| kappa vs top (95% CI) | [-0.137, -0.022] | — |
| n/a: both / gold only / model only | 0 / 34 / 0 | 0 / 37 / 0 |
| overall score mean abs diff | 2.08 | 2.56 |
| quote checks failed | 121 / 793 | 44 / 578 |
| verdicts downgraded (no quote) | 87 | 43 |
| pairs complete / incomplete | 23 / 0 | 23 / 0 |
| calls | 0 | 0 |
| input tokens | 709095 | 715104 |
| output tokens | 110464 | 71895 |
| cost ($) | 0.0000 | 0.0000 |
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
| arc-challenge | des.08 | 15 | 0 | 0 | 30 |
| arc-challenge | des.09 | 15 | 0 | 0 | 30 |
| arc-challenge | doc.01 | 15 | 0 | 0 | 30 |
| arc-challenge | doc.12 | 15 | 0 | 0 | 30 |
| arc-challenge | mai.01 | 15 | 0 | 0 | 30 |
