# Automation and auditing

## The nightly job

`.github/workflows/nightly.yml` runs daily at 04:17 UTC, and on demand.

1. **Watch.** For each benchmark, read the latest arXiv version from the arXiv API and the default branch's head commit from the GitHub API. Results go to `data/watch/state.json`.
2. **Queue.** A (benchmark, standard) pair is queued when it has no automated assessment, its sources changed since the last one, or the standard's version changed. Standards apply only within their `scope` (ABC to agent benchmarks, STREAM to safety benchmarks). The order is deterministic: changed sources, then revised standards, then new pairs, each by id.
3. **Assess** up to `--max-calls` model calls (default 40, set by the `TOUCHSTONE_MAX_CALLS` repository variable). Unfinished pairs wait for the next night.
4. **Check.** Validate every file and run the tests.
5. **Propose.** Commit to a `nightly/<date>` branch and open a pull request. Nothing is published until a person merges it.

Pull requests opened with the workflow's own token do not trigger other workflows, which is why the nightly job runs validation and tests itself.

## The model

The model must be on [`config/models.yaml`](../config/models.yaml): open weights under an OSI-approved licence, so anyone can download the same model and repeat a run. The default is `openai/gpt-oss-120b` (Apache-2.0) through GitHub Models, which Actions can call with the workflow's token (`permissions: models: read`) at no cost within the free rate limits.

Any OpenAI-compatible endpoint works:

| Variable | Default | Meaning |
|---|---|---|
| `TOUCHSTONE_LLM_BASE_URL` | `https://models.github.ai/inference` | Chat-completions endpoint for models without their own `base_url` in `config/models.yaml` (an entry's `base_url` always wins); e.g. `http://localhost:11434/v1` for Ollama |
| `TOUCHSTONE_LLM_API_KEY` | `GITHUB_TOKEN` | Bearer token, sent only to hosted entries (those with `base_url` or `api_key_env`) or when `TOUCHSTONE_LLM_BASE_URL` is set; never to a local Ollama entry |
| `TOUCHSTONE_MODEL` | `default` in `config/models.yaml` | Must be on the allowlist |

Run it locally against Ollama:

```bash
ollama pull gpt-oss:20b
TOUCHSTONE_LLM_BASE_URL=http://localhost:11434/v1 TOUCHSTONE_MODEL=gpt-oss:20b \
  npx tsx src/cli.ts assess --benchmark truthfulqa --standard construct-validity
```

## What the model sees, and what happens to its answer

- **Sources** are fetched at immutable references: the PDF of a specific arXiv version (text extracted with a pinned `pdfjs-dist`), and the README, docs, dependency files and file listing of a specific commit. Each source's sha256 is recorded.
- **Excerpts.** Sources are split into ~1,200-character chunks. For each group of items, BM25 retrieval picks each item's top 3 chunks plus the group's top 6, within a 10,000-character budget. Ties break by position, so the selection is deterministic.
- **Prompt.** [`prompts/assess-group.md`](../prompts/assess-group.md), versioned by `prompt_version`. Requests use temperature 0 and a fixed seed.
- **Post-processing** ([`src/assess/run.ts`](../src/assess/run.ts), `finalize`), all deterministic:
  - a quote is kept only if, after normalisation (Unicode NFKC, quotes and dashes straightened, line-break hyphens rejoined, whitespace collapsed, lowercased), it appears in the excerpt it cites, and is 12 characters to 40 words long;
  - a positive verdict left with no verified quote becomes negative, with the model's proposal kept in the rationale;
  - `n/a` on an item with no n/a condition becomes negative;
  - a reply that is not valid JSON, or a value that is not allowed, leaves the item without a verdict (scored as unmet) and marks the run partial.

## Bake-off against BetterBench

`touchstone bakeoff --models <id,id,...> [--benchmark <id>] [--max-calls N] [--excerpt-chars N] [--out <dir>]` runs candidate models (any on the allowlist) on the 23 benchmarks BetterBench assessed by hand, using the same pipeline as `assess` for the `betterbench` standard, and scores each model's verdicts against BetterBench's. Output goes to `bakeoff/<date>/`: one `<model>/<benchmark>.json` per pair (verdict values and the transcript as in `data/runs`, with replies and reasoning verbatim; no excerpt text), plus `report.md` and `metrics.json`. A pair whose file has `complete: true` is skipped, so a crashed run resumes without re-spending; incomplete pairs are re-run and overwritten. `--max-calls` caps the whole run and never starts a pair it cannot finish. `--excerpt-chars N` sets the per-group excerpt budget (default 10,000, the nightly's value) and is recorded in each pair file; a complete pair made at a different budget is re-run, so put results for different budgets in different `--out` directories.

`--replay <dir>` rescores an earlier bake-off offline: instead of calling the model, each group takes the stored `response` from the matching pair file in `<dir>` (use it after changing quote checking or scoring). Source fetching, excerpt selection and post-processing run as normal. If a group's rebuilt prompt hashes differently from the stored `prompt_sha256`, the pair is marked incomplete with that error rather than guessed at. Replayed pairs record 0 calls and $0 cost, and the pair file and `metrics.json` record `replayed_from`. Use a new `--out` directory.

Per model it reports: items compared; exact agreement, agreement within 5 points and mean absolute error (numeric pairs only); quadratic-weighted Cohen's kappa over 0/5/10/15; n/a confusion counts (kept out of the others); the mean absolute difference of the engine's overall score against the gold one (complete pairs); quote checks failed and verdicts downgraded for unsupported quotes; complete and incomplete pairs; calls, tokens and cost (`n/a` unless the endpoint reports `usage.cost`); and the providers that served the calls, to confirm pinning held. It also reports each model's bias (mean model − gold, in points) and benchmark-level bootstrap 95% CIs for kappa, MAE and exact agreement, plus the CI of each model's kappa difference from the top model. `report.md` also lists the 10 items with the most disagreement across models.

A pair is marked incomplete when the response's `model` field names a different model than the one requested. DeepInfra retired OLMo 3.1 and silently served Gemma 4 for that id (found 2026-10-28), so the bake-off now checks the served model.

## Reviewing a nightly pull request

For each changed `*.auto.yaml`, read each verdict's rationale and evidence. To overrule the model, change the verdict and set `by: human`; human verdicts survive later re-runs and are flagged for re-review when sources change. When satisfied, set `status: published` and add yourself to `provenance.reviewers`.

## Auditing a run

Each automated assessment records `model_run`: the model, provider, licence, temperature, seed, prompt version, the hash of every source, and the transcript path. The transcript (`data/runs/<benchmark>/<standard>/<date>.jsonl`) holds, per group, the excerpt ids shown, the prompt's sha256, the raw response, the model's separate reasoning when the provider returns it, and the outcome of every quote check.

Transcripts store excerpt ids rather than excerpt text, to avoid republishing papers. Because sources are pinned and excerpt selection is deterministic, the exact prompts can be rebuilt:

```bash
npx tsx src/cli.ts replay --benchmark truthfulqa --standard aisl-scorecard
```

`replay` re-fetches the pinned sources, checks their hashes, re-selects the excerpts and re-renders each prompt, and fails if anything differs from the record. Hosted models are not guaranteed to be bit-for-bit repeatable even at temperature 0, which is why responses are stored verbatim rather than relied on to recur.
