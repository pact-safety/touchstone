# Bake-off against BetterBench, 2026-10-27

Each model assessed the benchmarks BetterBench scored by hand; its verdicts are compared with BetterBench's. Agreement, MAE and kappa use only items where both gave a number; n/a is counted separately.

| | google/gemma-4-31b-it | qwen/qwen3.6-35b-a3b | deepseek/deepseek-v4.1-flash-1017 | openai/gpt-oss-120b |
|---|---|---|---|---|
| items compared (missing) | 1047 (34) | 1010 (71) | 1081 (0) | 1081 (0) |
| numeric items | 1014 | 976 | 1044 | 1044 |
| exact agreement % | 46.9 | 51.3 | 34.7 | 33.4 |
| within 5 points % | 61.6 | 67.3 | 57.8 | 44.6 |
| MAE (points) | 5.90 | 5.25 | 6.58 | 8.00 |
| quadratic kappa | 0.297 | 0.361 | 0.234 | 0.100 |
| kappa 95% CI | [0.245, 0.357] | [0.301, 0.418] | [0.202, 0.271] | [0.067, 0.140] |
| MAE 95% CI | [5.34, 6.45] | [4.78, 5.71] | [6.09, 7.05] | [7.35, 8.66] |
| exact % 95% CI | [43.2, 50.6] | [46.9, 55.8] | [30.4, 38.8] | [29.2, 37.6] |
| bias (model − gold, points) | -4.60 | -3.21 | -6.12 | -7.51 |
| kappa vs top (95% CI) | [-0.107, -0.017] | — | [-0.166, -0.083] | [-0.317, -0.200] |
| n/a: both / gold only / model only | 0 / 33 / 0 | 0 / 34 / 0 | 0 / 37 / 0 | 0 / 37 / 0 |
| overall score mean abs diff | 4.88 | 3.88 | 6.24 | 7.57 |
| quote checks failed | 88 / 441 | 90 / 576 | 27 / 407 | 71 / 245 |
| verdicts downgraded (no quote) | 88 | 73 | 25 | 64 |
| pairs complete / incomplete | 23 / 0 | 23 / 0 | 23 / 0 | 23 / 0 |
| calls | 92 | 98 | 92 | 126 |
| input tokens | 339666 | 335807 | 316213 | 318650 |
| output tokens | 62892 | 96551 | 58479 | 83989 |
| cost ($) | 0.0931 | 0.1253 | 0.0470 | 0.0261 |
| providers | DeepInfra | DeepInfra | DeepInfra | DeepInfra |

The 95% CIs resample benchmarks (2000 draws, fixed seed), not items, because items within a benchmark are not independent; "kappa vs top" is the CI of the difference from the highest-kappa model on the same resamples.

## Items with the most disagreement

| benchmark | item | BetterBench | google/gemma-4-31b-it | qwen/qwen3.6-35b-a3b | deepseek/deepseek-v4.1-flash-1017 | openai/gpt-oss-120b | total abs diff |
|---|---|---|---|---|---|---|---|
| agentbench | des.06 | 15 | 0 | 0 | 0 | 0 | 60 |
| agentbench | des.11 | 15 | 0 | 0 | 0 | 0 | 60 |
| agentbench | des.12 | 15 | 0 | 0 | 0 | 0 | 60 |
| agentbench | des.13 | 15 | 0 | 0 | 0 | 0 | 60 |
| agentbench | doc.06 | 15 | 0 | 0 | 0 | 0 | 60 |
| agentbench | doc.07 | 15 | 0 | 0 | 0 | 0 | 60 |
| agentbench | doc.11 | 15 | 0 | 0 | 0 | 0 | 60 |
| agentbench | doc.12 | 15 | 0 | 0 | 0 | 0 | 60 |
| agentbench | doc.16 | 15 | 0 | 0 | 0 | 0 | 60 |
| agentbench | mai.01 | 15 | 0 | 0 | 0 | 0 | 60 |
