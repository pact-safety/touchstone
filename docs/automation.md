# Automation and auditing

## The re-assessment job

`.github/workflows/nightly.yml` is run manually for now (Actions > Nightly re-assessment > Run workflow). Its daily schedule (04:17 UTC) is commented out, so scheduling is paused.

1. **Watch.** For each benchmark, read the latest arXiv version from the arXiv API and the default branch's head commit from the GitHub API. Results go to `data/watch/state.json`.
2. **Queue.** A (benchmark, standard) pair is queued when it has no automated assessment, its sources changed since the last one, or the standard's version changed. Standards apply only within their `scope` (ABC to agent benchmarks, STREAM to safety benchmarks). The order is deterministic: changed sources, then revised standards, then new pairs, each by id.
3. **Assess** up to `--max-calls` model calls (default 40, set by the `TOUCHSTONE_MAX_CALLS` repository variable). Unfinished pairs wait for the next run.
4. **Check.** Validate every file and run the tests.
5. **Propose.** Commit to a `nightly/<date>` branch and open a pull request. Nothing is published until a person merges it.

Pull requests opened with the workflow's own token do not trigger other workflows, which is why the job runs validation and tests itself.

## The candidate watchers

`.github/workflows/watch.yml` runs two watchers that file GitHub issues for things worth adding to the corpus. Nothing is assessed or published automatically; a person reviews each issue.

| Watcher | When (UTC) | Looks at | Window |
|---|---|---|---|
| `watch --source arxiv` | daily 02:30 | new cs.CL / cs.LG / cs.AI papers whose title or abstract mentions benchmark, evaluation suite, eval suite or leaderboard | 72 h |
| `watch --source news` | hourly, :17 | the feeds in [`config/watch.yaml`](../config/watch.yaml) | 48 h |

Both also run on demand (Actions > Watch > Run workflow, with `dry_run` on by default). Locally: `node --env-file=.env --import tsx src/cli.ts watch --source news --dry-run [--max N]`.

1. **Fetch and parse** RSS/Atom (a small built-in reader; feeds that send ETag or Last-Modified are fetched conditionally).
2. **Filter without tokens:** keep items inside the window, drop ids already in the seen-state, then a keyword prefilter (arXiv: a term in the title or "we introduce ... benchmark" in the abstract; news: the feed's AI-only rule plus benchmark/standard words by the feed's `for` tag).
3. **Triage** the survivors only, newest first, at most 120 (arXiv) or 20 (news) per run (`--max N` or `max_triage` in the config; the rest are logged as deferred and tried again next run while still in the window). One call per item to the model named by `model:` in `config/watch.yaml` (`qwen/qwen3.6-35b-a3b`, DeepInfra via OpenRouter, key `TOUCHSTONE_LLM_API_KEY`, about $0.0002 per item) with the title and the first ~2,000 characters in a block the prompt labels untrusted data. The prompt is strict: a benchmark counts only if it is the item's primary contribution, a standard only if it proposes or revises a standard, checklist, framework or guideline for benchmark quality or evaluation practice. The reply must be exactly `{relevant, kind, primary_contribution, confidence, in_scope, releases_artifacts, evidence, reason}`; anything else counts as not relevant and is logged. An item is filed only if `relevant && primary_contribution && confidence != "low"`. `in_scope` (the benchmark evaluates general-purpose LLMs or agents on capability or safety/alignment/security, not a narrow domain model or task), `evidence` (a sentence quoted from the abstract) decide the arXiv digest section, and `releases_artifacts` (the abstract says code, data or a leaderboard is available) only adds a tag; the code checks that `evidence` really occurs in the abstract (same normalisation as the assessor's quote check) and otherwise sets `in_scope` to false.
4. **File issues.**
   - **arXiv: one digest issue per day**, label `candidate-benchmark`, titled `[arXiv digest] YYYY-MM-DD: N in scope (+M other)`. The **In scope** section lists standards first, then benchmarks with `in_scope` and a verified evidence quote (linked title, arXiv id, kind, confidence, a `code/data: stated` or `code/data: not stated in abstract` tag, reason, the quote). The remaining filed benchmarks go in a collapsed `<details>` list, one line each. No issue when both counts are 0. A digest whose title date already exists is not repeated (those papers stay unseen and are retried next run), and papers whose arXiv id already appears in an earlier issue are dropped.
   - **News: one issue per item**, label `candidate-benchmark` or `candidate-standard` (created if missing), title `[candidate benchmark] <title>`, body with the link, date, feed and the model's one-sentence reason. Before creating, the watcher searches existing issues (open and closed) for the URL, so a lost cache cannot duplicate.
   - Feed and model text is stripped of HTML, length-capped, and has @mentions and `#123` references defused.

**Scope eval.** An internal tuning check on a small hand-labelled set, not a validated benchmark. Gemma's `in_scope` said yes to 46 of 48 papers, so the prompt and model were chosen on a frozen set: the 71 prefiltered arXiv items of one 72 h window, labelled by hand with the rubric now in the prompt (28 in scope). Precision and recall of the in-scope decision (`relevant && primary && in_scope && verified evidence`) against those labels:

| Variant | Count | Precision | Recall | Cost |
|---|---|---|---|---|
| a. earlier prompt, Gemma | 43 | 0.58 | 0.89 | $0.014 |
| b. rubric + 4 examples, Gemma | 36 | 0.69 | 0.89 | $0.016 |
| c. as b, 0-3 score, need 2+, Gemma | 40 | 0.63 | 0.89 | $0.017 |
| d. as b, Qwen3.6-35B-A3B | 26 | 0.77 | 0.71 | $0.015 |

d had the best precision with recall at or above 0.7 and was chosen; a re-run of the chosen prompt gave 27 / 0.78 / 0.75, so expect about +/-0.05 between runs. It is one labelled day, so treat the numbers as a rough guide.

**Seen-state** is `data/watch/seen-<source>.json` (gitignored), kept between runs with `actions/cache` (restore by prefix, new key each run) and pruned after 30 days. Dry runs never save it.

**Cost.** Each run's job summary shows items at every stage, tokens, and cost (`usage.cost`, or `estimated_cost` if that is what the provider reports). The step fails with a clear message if the `TOUCHSTONE_LLM_API_KEY` secret is missing.

**Add a source.** Append an entry to `news.feeds` in `config/watch.yaml` with a `name`, `url` and `for` (`benchmark`, `standard` or `both`); add `ai_only: true` for general news feeds. No code change is needed. Sources without a usable feed (aisi.gov.uk blog, betterbench, iso.org) are listed there as a comment.

## The model

The model must be on [`config/models.yaml`](../config/models.yaml): open weights under an OSI-approved licence, so anyone can download the same model and repeat a run. The 307 automated drafts in `data/assessments` were produced by `google/gemma-4-31b-it` through OpenRouter. The default for a run is whatever `default` in `config/models.yaml` says; set `TOUCHSTONE_MODEL` to use another model on the list.

Any OpenAI-compatible endpoint works:

| Variable | Default | Meaning |
|---|---|---|
| `TOUCHSTONE_LLM_BASE_URL` | `http://localhost:11434/v1` (local Ollama) | Chat-completions endpoint for models without their own `base_url` in `config/models.yaml` (an entry's `base_url` always wins); e.g. `http://localhost:11434/v1` for Ollama |
| `TOUCHSTONE_LLM_API_KEY` | none | Bearer token, sent only to hosted entries (those with `base_url` or `api_key_env`) or when `TOUCHSTONE_LLM_BASE_URL` is set; never to a local Ollama entry |
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
- **Prompt.** [`prompts/assess-group.md`](../prompts/assess-group.md), versioned by `prompt_version`. Requests use temperature 0 and a fixed seed. Re-running a hosted model is not bit-for-bit repeatable; replay checks inputs and stored outputs, not that the model reproduces them.
- **Post-processing** ([`src/assess/run.ts`](../src/assess/run.ts), `finalize`), all deterministic:
  - a quote is kept only if, after normalisation (Unicode NFKC, quotes and dashes straightened, line-break hyphens rejoined, whitespace collapsed, lowercased), it appears in the excerpt it cites, and is 12 characters to 40 words long;
  - a positive verdict left with no verified quote becomes negative, with the model's proposal kept in the rationale;
  - `n/a` on an item with no n/a condition becomes negative;
  - a reply that is not valid JSON, or a value that is not allowed, leaves the item without a verdict (scored as unmet) and marks the run partial.

## Bake-off against BetterBench

`touchstone bakeoff --models <id,id,...> [--benchmark <id>] [--max-calls N] [--excerpt-chars N] [--out <dir>]` runs candidate models (any on the allowlist) on the 23 benchmarks BetterBench assessed by hand, using the same pipeline as `assess` for the `betterbench` standard, and scores each model's verdicts against BetterBench's. Output goes to `bakeoff/<date>/`: one `<model>/<benchmark>.json` per pair (verdict values and the transcript as in `data/runs`, with replies and reasoning verbatim; no excerpt text), plus `report.md` and `metrics.json`. A pair whose file has `complete: true` is skipped, so a crashed run resumes without re-spending; incomplete pairs are re-run and overwritten. `--max-calls` caps the whole run and never starts a pair it cannot finish. `--excerpt-chars N` sets the per-group excerpt budget (default 10,000, the nightly's value) and is recorded in each pair file; a complete pair made at a different budget is re-run, so put results for different budgets in different `--out` directories.

`--replay <dir>` rescores an earlier bake-off offline: instead of calling the model, each group takes the stored `response` from the matching pair file in `<dir>` (use it after changing quote checking or scoring). Source fetching, excerpt selection and post-processing run as normal. If a group's rebuilt prompt hashes differently from the stored `prompt_sha256`, the pair is marked incomplete with that error rather than guessed at. Replayed pairs record 0 calls and $0 cost, and the pair file and `metrics.json` record `replayed_from`. Use a new `--out` directory.

Per model it reports: items compared; exact agreement, agreement within 5 points and mean absolute error (numeric pairs only); quadratic-weighted Cohen's kappa over 0/5/10/15; n/a confusion counts (kept out of the others); the mean absolute difference of the engine's overall score against the gold one (complete pairs); quote checks failed and verdicts downgraded for unsupported quotes; complete and incomplete pairs; calls, tokens and cost (`n/a` unless the endpoint reports `usage.cost`); and the providers that served the calls, to confirm pinning held. It also reports each model's bias (mean model − gold, in points) and benchmark-level bootstrap 95% CIs for kappa, MAE and exact agreement, plus the CI of each model's kappa difference from the top model. `report.md` also lists the 10 items with the most disagreement across models.

A pair is marked incomplete when the response's `model` field names a different model than the one requested. DeepInfra retired OLMo 3.1 and silently served Gemma 4 for that id, so the bake-off now checks the served model.

## Reviewing a re-assessment pull request

For each changed `*.auto.yaml`, read each verdict's rationale and evidence. To overrule the model, change the verdict and set `by: human`; human verdicts survive later re-runs and are flagged for re-review when sources change. When satisfied, set `status: published` and add yourself to `provenance.reviewers`.

## Auditing a run

Each automated assessment records `model_run`: the model, provider, licence, temperature, seed, prompt version, the hash of every source, and the transcript path. The transcript (`data/runs/<benchmark>/<standard>/<date>.jsonl`) holds, per group, the excerpt ids shown, the prompt's sha256, the raw response, the model's separate reasoning when the provider returns it, and the outcome of every quote check.

Transcripts store excerpt ids rather than excerpt text, to avoid republishing papers. Because sources are pinned and excerpt selection is deterministic, the exact prompts can be rebuilt:

```bash
npx tsx src/cli.ts replay --benchmark truthfulqa --standard aisl-scorecard
```

`replay` re-fetches the pinned sources, checks their hashes, re-selects the excerpts and re-renders each prompt, and fails if anything differs from the record. Hosted models are not guaranteed to be bit-for-bit repeatable even at temperature 0, which is why responses are stored verbatim rather than relied on to recur.
