#!/usr/bin/env -S npx tsx
/**
 * touchstone <command>
 *   validate                         Check every file against the schema and cross-file rules.
 *   build --out <file>               Write the site's data file.
 *   watch [--write]                  Check sources for changes; print (and with --write, save) the work queue.
 *   assess [--benchmark id] [--standard id] [--queue] [--max-calls n]
 *                                    Run the automated assessor (see docs/automation.md for environment variables).
 *   bakeoff --models id,id [--benchmark id] [--max-calls n] [--excerpt-chars n] [--out dir]
 *                                    Run candidate models on the benchmarks BetterBench assessed by hand and score them against it.
 *   replay --benchmark id --standard id
 *                                    Re-fetch pinned sources and check they and every prompt hash match the run record.
 *   triage --body-file <file>        Print the triage comment for a correction request (JSON: ok, labels, comment).
 *   check-revisions --base <ref>     Fail if changed verdicts lack a revision entry.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parse, stringify } from 'yaml';
import { load } from './load.ts';
import { validate } from './validate.ts';
import { writeSiteData } from './build.ts';
import { check, queue, inScope, type WatchState } from './watch.ts';
import { assess, promptTemplate, renderPrompt, selectExcerpts, type TranscriptEntry } from './assess/run.ts';
import { currentPins, fetchSources, type FetchedSource } from './assess/sources.ts';
import { sha256, verifyQuote } from './assess/text.ts';
import { triage } from './triage.ts';
import { checkRevisions } from './revisions.ts';
import type { Assessment, Benchmark } from './schema.ts';
import { llmConfig as llmConfigOf } from './llm-config.ts';
import { runBakeoff } from './bakeoff.ts';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const today = () => new Date().toISOString().slice(0, 10);
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' }, write: { type: 'boolean' }, benchmark: { type: 'string' }, standard: { type: 'string' },
    queue: { type: 'boolean' }, 'max-calls': { type: 'string' }, 'excerpt-chars': { type: 'string' }, 'body-file': { type: 'string' }, base: { type: 'string' },
    date: { type: 'string' }, models: { type: 'string' },
  },
});
const cmd = positionals[0];
const fail = (msg: string): never => { console.error(msg); process.exit(1); };

function loadValid() {
  const c = load(root);
  const errors = validate(c);
  if (errors.length) fail(`${errors.length} validation error(s):\n` + errors.map((e) => `  ${e}`).join('\n'));
  return c;
}

const watchPath = join(root, 'data/watch/state.json');
const readWatch = (): WatchState | null => (existsSync(watchPath) ? JSON.parse(readFileSync(watchPath, 'utf8')) : null);
const writeFile = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

const maxCalls = (v?: string) => {
  if (v === undefined) return Infinity;
  if (!/^[1-9]\d*$/.test(v)) fail(`--max-calls must be a positive integer (got "${v}").`);
  return Number(v);
};
const excerptChars = (v?: string) => {
  if (v === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(v)) fail(`--excerpt-chars must be a positive integer (got "${v}").`);
  return Number(v);
};
const llmConfig = (c: ReturnType<typeof load>, modelOverride?: string) => {
  try { return llmConfigOf(c, modelOverride); } catch (e) { return fail((e as Error).message); }
};

/** Pins and fetched sources for a benchmark, fetched once per process however many pairs use them. */
const sourceCache = new Map<string, { pins: Awaited<ReturnType<typeof currentPins>>; sources: FetchedSource[] }>();
async function sourcesFor(b: Benchmark) {
  if (!sourceCache.has(b.id)) {
    const pins = readWatch()?.benchmarks[b.id] ?? (await currentPins(b, process.env.GITHUB_TOKEN));
    sourceCache.set(b.id, { pins, sources: await fetchSources(b, pins, process.env.GITHUB_TOKEN) });
  }
  return sourceCache.get(b.id)!;
}

/** The weights digest an Ollama server reports for a model, so a run records exactly which weights it used. */
async function ollamaDigest(baseUrl: string, model: string): Promise<string | undefined> {
  try {
    const origin = new URL(baseUrl).origin;
    const res = await fetch(`${origin}/api/tags`);
    if (!res.ok) return undefined;
    const d = (await res.json()) as { models?: { name: string; model?: string; digest?: string }[] };
    const m = d.models?.find((x) => x.name === model || x.model === model);
    return m?.digest ? `sha256:${m.digest.replace(/^sha256:/, '')}` : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  switch (cmd) {
    case 'validate': {
      const c = loadValid();
      console.log(`ok: ${c.standards.length} standards, ${c.benchmarks.length} benchmarks, ${c.assessments.length} assessments`);
      return;
    }
    case 'build': {
      const c = loadValid();
      const out = values.out ?? 'site/public/data';
      console.log(`wrote ${writeSiteData(c, resolve(root, out))} files to ${out}`);
      return;
    }
    case 'watch': {
      const c = loadValid();
      const state = await check(c, values.date ?? today(), process.env.GITHUB_TOKEN);
      if (values.write) writeFile(watchPath, JSON.stringify(state, null, 1) + '\n');
      console.log(JSON.stringify({ errors: Object.entries(state.benchmarks).filter(([, p]) => p.error).map(([id, p]) => `${id}: ${p.error}`), queue: queue(c, state) }, null, 1));
      return;
    }
    case 'assess': {
      const c = loadValid();
      const { entry, llm } = llmConfig(c);
      const budget = maxCalls(values['max-calls']);
      const date = values.date ?? today();
      let targets: { benchmark: string; standard: string }[];
      if (values.queue) {
        const state = readWatch() ?? fail('Run `touchstone watch --write` first.');
        targets = queue(c, state!);
      } else {
        const bs = c.benchmarks.map((b) => b.value).filter((b) => !values.benchmark || b.id === values.benchmark);
        const ss = c.standards.map((s) => s.value).filter((s) => !values.standard || s.id === values.standard);
        targets = bs.flatMap((b) => ss.filter((s) => inScope(s, b)).map((s) => ({ benchmark: b.id, standard: s.id })));
      }
      if (!targets.length) { console.log('nothing to assess'); return; }
      let used = 0;
      let written = 0;
      let failed = 0;
      const modelDigest = await ollamaDigest(llm.baseUrl, llm.model);
      for (const t of targets) {
        const b = c.benchmarks.find((x) => x.value.id === t.benchmark)!.value;
        const s = c.standards.find((x) => x.value.id === t.standard)!.value;
        // A pair needs one call per group; never start one the budget can't finish.
        if (used + s.groups.length > budget) { console.log(`call budget reached; ${targets.length - targets.indexOf(t)} pair(s) left for the next run`); break; }
        const { pins, sources } = await sourcesFor(b);
        if (!sources.length) { console.log(`${b.id}: no paper or repo to read; skipped`); continue; }
        const transcriptPath = `data/runs/${b.id}/${s.id}/${date}.jsonl`;
        const run = await assess({
          benchmark: b, standard: s, sources, llm, provider: entry.provider, license: entry.license, runOn: date,
          transcriptPath, pins: { paper_version: pins.paper_version, repo_commit: pins.repo_commit }, modelDigest,
        });
        used += run.calls;
        // An assessment is only recorded when every group got a usable answer. A partial or failed run is
        // reported and its transcript kept outside the data, so nothing half-assessed is ever scored.
        if (!run.complete) {
          failed++;
          writeFile(join(root, `runs-failed/${b.id}/${s.id}/${date}.jsonl`), run.transcript.map((e) => JSON.stringify(e)).join('\n') + '\n');
          const errs = [...new Set(run.transcript.map((e) => e.error).filter(Boolean))];
          console.log(`${b.id} × ${s.id}: NOT RECORDED, run incomplete (${run.calls} call(s))${errs.length ? `: ${errs.join(' | ').slice(0, 300)}` : ''}`);
          continue;
        }
        // A person's correction outlives a model re-run; it is kept and flagged for review against the new sources.
        const autoPath = join(root, `data/assessments/${b.id}/${s.id}.auto.yaml`);
        if (existsSync(autoPath)) {
          const prev = parse(readFileSync(autoPath, 'utf8')) as Assessment;
          const kept = Object.entries(prev.verdicts ?? {}).filter(([, v]) => v.by === 'human');
          for (const [id, v] of kept) run.assessment.verdicts![id] = v;
          run.assessment.revisions = [...prev.revisions, ...run.assessment.revisions];
          if (kept.length) run.assessment.revisions.at(-1)!.summary += ` Kept ${kept.length} human verdict(s) (${kept.map(([id]) => id).join(', ')}); review them against the new sources.`;
        }
        writeFile(autoPath, `# Proposed by the automated assessor. Review before publishing: see docs/automation.md.\n` + stringify(run.assessment, { lineWidth: 0 }));
        writeFile(join(root, transcriptPath), run.transcript.map((e) => JSON.stringify(e)).join('\n') + '\n');
        written++;
        console.log(`${b.id} × ${s.id}: recorded (${run.calls} call(s))`);
      }
      console.log(`${written} assessment(s) recorded, ${failed} incomplete, ${used} call(s) used`);
      // Every attempted pair failing means the model or endpoint is broken: fail the job loudly.
      if (failed > 0 && written === 0) process.exit(1);
      return;
    }
    case 'bakeoff': {
      const c = loadValid();
      const ids = (values.models ?? fail('--models is required (comma-separated ids from config/models.yaml)')).split(',').map((x) => x.trim()).filter(Boolean);
      const models = ids.map((id) => llmConfig(c, id));
      // Fail before any spend if a key the model needs is missing (only the variable's name is shown).
      for (const m of models) {
        if (m.keyEnv && !m.llm.apiKey) fail(`${m.llm.model}: environment variable ${m.keyEnv} is not set.`);
      }
      const date = values.date ?? today();
      await runBakeoff({
        c, models, date, out: resolve(root, values.out ?? `bakeoff/${date}`), benchmark: values.benchmark,
        maxCalls: maxCalls(values['max-calls']), excerptChars: excerptChars(values['excerpt-chars']), sourcesFor, log: console.log,
      });
      return;
    }
    case 'replay': {
      const c = loadValid();
      const a = c.assessments.find((x) => x.value.benchmark === values.benchmark && x.value.standard === values.standard && x.value.provenance.kind === 'automated')?.value;
      if (!a?.model_run) fail('No automated assessment for that pair.');
      const b = c.benchmarks.find((x) => x.value.id === a!.benchmark)!.value;
      const s = c.standards.find((x) => x.value.id === a!.standard)!.value;
      const sources = await fetchSources(b, a!.benchmark_ref ?? {}, process.env.GITHUB_TOKEN);
      let ok = true;
      for (const snap of a!.model_run!.sources) {
        const now = sources.find((x) => x.snapshot.kind === snap.kind);
        const same = now?.snapshot.sha256 === snap.sha256;
        ok &&= same;
        console.log(`${snap.kind} ${snap.ref}: ${same ? 'matches' : 'DIFFERS from'} the text the model was given`);
      }
      const chunks = sources.flatMap((x) => x.chunks);
      const chunkText = new Map(chunks.map((x) => [x.locator, x.text]));
      for (const [id, v] of Object.entries(a!.verdicts ?? {})) {
        if (v.by !== 'model') continue;
        for (const e of v.evidence) {
          if (!e.quote) continue;
          const text = chunkText.get(e.locator);
          if (text === undefined || !verifyQuote(e.quote, text)) {
            ok = false;
            console.log(`${id}: quote NOT found at ${e.locator}: "${e.quote}"`);
          }
        }
      }
      const tpl = promptTemplate();
      const lines = readFileSync(join(root, a!.model_run!.transcript), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TranscriptEntry);
      for (const e of lines) {
        const g = s.groups.find((x) => x.id === e.group)!;
        const ex = selectExcerpts(g, chunks);
        const sameEx = JSON.stringify(ex.map((x) => x.id)) === JSON.stringify(e.excerpts);
        const same = sha256(renderPrompt(tpl, b, s, g, ex)) === e.prompt_sha256;
        ok &&= same && sameEx;
        console.log(`${e.group}: excerpts ${sameEx ? 'match' : 'DIFFER'}, prompt ${same ? 'matches' : 'DIFFERS'}`);
      }
      if (!ok) process.exit(1);
      return;
    }
    case 'triage': {
      const c = load(root);
      const body = readFileSync(values['body-file'] ?? fail('--body-file is required'), 'utf8');
      console.log(JSON.stringify(triage(c, body)));
      return;
    }
    case 'check-revisions': {
      const errors = checkRevisions(root, values.base ?? fail('--base is required'));
      if (errors.length) fail(errors.join('\n'));
      console.log('ok: every verdict change has a revision entry');
      return;
    }
    default:
      fail('usage: touchstone <validate|build|watch|assess|bakeoff|replay|triage|check-revisions> (see src/cli.ts)');
  }
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
