# Bake-off

A bake-off runs candidate models through the same assessor as `assess`, on the 23 benchmarks that BetterBench scored by hand, and compares each model's verdicts with BetterBench's. Each folder holds one `<model>/<benchmark>.json` per pair, `metrics.json` and `report.md`. See [docs/automation.md](../docs/automation.md) for the command and the metrics.

Folders are named by start date, then by what differs. All use the `betterbench` standard.

| Folder | What it is |
|---|---|
| `2026-10-27` | The first run: four models (Gemma 4 31B, Qwen3.6 35B-A3B, DeepSeek V4.1 Flash, gpt-oss-120b) with the default 10,000-character excerpt budget. |
| `2026-10-28-40k` | Qwen3.6 and Gemma 4 with a 40,000-character excerpt budget. Its quote check wrongly rejected some verbatim quotes. |
| `2026-10-28-40k-rescored` | The `40k` replies rescored offline (`--replay`) with the quote check fixed. No model calls. |
| `2026-10-28-40k-rescored-v2` | `40k-rescored` rescored again after a fix to how replies are parsed. No model calls. |
| `2026-10-28-40k-run2` | A fresh 40,000-character run of the same two models, made after the quote-check fix. |
| `2026-10-28-40k-run2-rescored` | The `run2` replies rescored offline after the parser fix. No model calls. |

`replayed_from` in a rescored pair file and in `metrics.json` names the folder it was replayed from, relative to the repository root.
