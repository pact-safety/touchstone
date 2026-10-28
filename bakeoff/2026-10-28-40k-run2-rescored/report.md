# Bake-off against BetterBench, 2026-10-28

Each model assessed the benchmarks BetterBench scored by hand; its verdicts are compared with BetterBench's. Agreement, MAE and kappa use only items where both gave a number; n/a is counted separately.

Excerpt budget: 40000 characters per group.

| | qwen/qwen3.6-35b-a3b | google/gemma-4-31b-it |
|---|---|---|
| items compared (missing) | 1078 (3) | 1042 (39) |
| numeric items | 1041 | 1005 |
| exact agreement % | 56.0 | 56.4 |
| within 5 points % | 71.9 | 73.5 |
| MAE (points) | 4.63 | 4.38 |
| quadratic kappa | 0.405 | 0.454 |
| kappa 95% CI | [0.350, 0.455] | [0.400, 0.503] |
| MAE 95% CI | [4.29, 4.98] | [4.03, 4.74] |
| exact % 95% CI | [52.6, 59.0] | [53.0, 59.9] |
| bias (model − gold, points) | -0.96 | -1.61 |
| kappa vs top (95% CI) | [-0.097, 0.004] | — |
| n/a: both / gold only / model only | 0 / 37 / 0 | 0 / 37 / 0 |
| overall score mean abs diff | 1.64 | 2.40 |
| quote checks failed | 130 / 868 | 38 / 591 |
| verdicts downgraded (no quote) | 87 | 38 |
| pairs complete / incomplete | 23 / 0 | 23 / 0 |
| calls | 0 | 0 |
| input tokens | 709191 | 715200 |
| output tokens | 114252 | 72086 |
| cost ($) | 0.0000 | 0.0000 |
| providers | DeepInfra | DeepInfra |

The 95% CIs resample benchmarks (2000 draws, fixed seed), not items, because items within a benchmark are not independent; "kappa vs top" is the CI of the difference from the highest-kappa model on the same resamples.

## Items with the most disagreement

| benchmark | item | BetterBench | qwen/qwen3.6-35b-a3b | google/gemma-4-31b-it | total abs diff |
|---|---|---|---|---|---|
| agentbench | imp.07 | 0 | 15 | 15 | 30 |
| ale | doc.03 | 15 | 0 | 0 | 30 |
| ale | imp.11 | 15 | 0 | 0 | 30 |
| ale | mai.01 | 15 | 0 | 0 | 30 |
| ale | mai.02 | 15 | 0 | 0 | 30 |
| ale | mai.03 | 15 | 0 | 0 | 30 |
| arc-challenge | des.11 | 15 | 0 | 0 | 30 |
| arc-challenge | doc.01 | 15 | 0 | 0 | 30 |
| arc-challenge | doc.12 | 15 | 0 | 0 | 30 |
| arc-challenge | imp.04 | 15 | 0 | 0 | 30 |
