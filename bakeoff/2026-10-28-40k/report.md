# Bake-off against BetterBench, 2026-10-28

Each model assessed the benchmarks BetterBench scored by hand; its verdicts are compared with BetterBench's. Agreement, MAE and kappa use only items where both gave a number; n/a is counted separately.

Excerpt budget: 40000 characters per group.

| | qwen/qwen3.6-35b-a3b | google/gemma-4-31b-it |
|---|---|---|
| items compared (missing) | 1021 (60) | 1020 (61) |
| numeric items | 987 | 983 |
| exact agreement % | 52.8 | 51.2 |
| within 5 points % | 67.3 | 65.4 |
| MAE (points) | 5.14 | 5.38 |
| quadratic kappa | 0.351 | 0.339 |
| kappa 95% CI | [0.292, 0.404] | [0.264, 0.419] |
| MAE 95% CI | [4.74, 5.55] | [4.71, 6.09] |
| exact % 95% CI | [49.1, 56.1] | [46.4, 55.6] |
| bias (model − gold, points) | -1.80 | -3.39 |
| kappa vs top (95% CI) | — | [-0.080, 0.062] |
| n/a: both / gold only / model only | 0 / 34 / 0 | 0 / 37 / 0 |
| overall score mean abs diff | 2.58 | 4.11 |
| quote checks failed | 181 / 793 | 161 / 578 |
| verdicts downgraded (no quote) | 134 | 160 |
| pairs complete / incomplete | 23 / 0 | 23 / 0 |
| calls | 92 | 92 |
| input tokens | 709095 | 715104 |
| output tokens | 110464 | 71895 |
| cost ($) | 0.1759 | 0.1718 |
| providers | DeepInfra | DeepInfra |

The 95% CIs resample benchmarks (2000 draws, fixed seed), not items, because items within a benchmark are not independent; "kappa vs top" is the CI of the difference from the highest-kappa model on the same resamples.

## Items with the most disagreement

| benchmark | item | BetterBench | qwen/qwen3.6-35b-a3b | google/gemma-4-31b-it | total abs diff |
|---|---|---|---|---|---|
| agentbench | doc.01 | 15 | 0 | 0 | 30 |
| agentbench | doc.02 | 15 | 0 | 0 | 30 |
| agentbench | doc.05 | 15 | 0 | 0 | 30 |
| agentbench | doc.06 | 15 | 0 | 0 | 30 |
| agentbench | doc.07 | 15 | 0 | 0 | 30 |
| agentbench | doc.10 | 15 | 0 | 0 | 30 |
| agentbench | doc.11 | 15 | 0 | 0 | 30 |
| agentbench | doc.12 | 15 | 0 | 0 | 30 |
| agentbench | doc.16 | 15 | 0 | 0 | 30 |
| agentbench | imp.07 | 0 | 15 | 15 | 30 |
