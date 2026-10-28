# Bake-off against BetterBench, 2026-10-28

Each model assessed the benchmarks BetterBench scored by hand; its verdicts are compared with BetterBench's. Agreement, MAE and kappa use only items where both gave a number; n/a is counted separately.

Excerpt budget: 40000 characters per group.

| | qwen/qwen3.6-35b-a3b | google/gemma-4-31b-it |
|---|---|---|
| items compared (missing) | 1078 (3) | 1042 (39) |
| numeric items | 1041 | 1005 |
| exact agreement % | 54.7 | 57.4 |
| within 5 points % | 70.5 | 73.7 |
| MAE (points) | 4.77 | 4.32 |
| quadratic kappa | 0.390 | 0.459 |
| kappa 95% CI | [0.339, 0.438] | [0.397, 0.515] |
| MAE 95% CI | [4.44, 5.11] | [3.95, 4.72] |
| exact % 95% CI | [51.1, 58.0] | [54.0, 60.5] |
| bias (model − gold, points) | -1.16 | -1.64 |
| kappa vs top (95% CI) | [-0.124, -0.013] | — |
| n/a: both / gold only / model only | 0 / 37 / 0 | 0 / 37 / 0 |
| overall score mean abs diff | 1.63 | 2.43 |
| quote checks failed | 125 / 839 | 45 / 592 |
| verdicts downgraded (no quote) | 92 | 44 |
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
