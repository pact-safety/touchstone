import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from '../src/load.ts';
import { llmConfig } from '../src/llm-config.ts';
import { chunk, sha256 } from '../src/assess/text.ts';
import type { FetchedSource } from '../src/assess/sources.ts';
import { goldAssessments, modelMetrics, runBakeoff, topDisagreements, weightedKappa, type PairFile } from '../src/bakeoff.ts';
import type { Assessment, Verdict } from '../src/schema.ts';

const corpus = load(new URL('..', import.meta.url).pathname);
const std = corpus.standards.find((s) => s.value.id === 'betterbench')!.value;

const asm = (benchmark: string, v: Record<string, Verdict['value']>): Assessment => ({
  ...goldAssessments(corpus, 'truthfulqa')[0]!, benchmark,
  verdicts: Object.fromEntries(Object.entries(v).map(([id, value]) => [id, { value, evidence: [], by: 'human' }])),
}) as Assessment;
const pair = (v: Record<string, Verdict['value']>, over: Partial<PairFile> = {}): PairFile =>
  ({ model: 'm', benchmark: 'truthfulqa', standard: 'betterbench', date: 'd', complete: true, calls: 4, verdicts: v, transcript: [], ...over });

describe('metrics', () => {
  // gold  = 0, 5, 10, 15, 15, 10 ; model = 0, 5, 15, 15, 10, 10  (levels indexed 0..3)
  // observed weighted disagreement: two items one level apart -> 1 + 1 = 2
  // marginals are both [1,1,2,2]; sum_ij (i-j)^2 g_i m_j = 2 * (1*1 + 4*2 + 9*2 + 1*2 + 4*2 + 1*4) = 82; expected = 82 / 6
  // kappa = 1 - 2 / (82/6) = 1 - 12/82 = 35/41 = 0.853658...
  const g = { 'des.01': 0, 'des.02': 5, 'des.03': 10, 'des.04': 15, 'des.05': 15, 'des.06': 10 } as const;
  const m = { 'des.01': 0, 'des.02': 5, 'des.03': 15, 'des.04': 15, 'des.05': 10, 'des.06': 10 } as const;

  it('computes quadratic-weighted kappa by hand', () => {
    const pairs = Object.keys(g).map((k) => [g[k as keyof typeof g], m[k as keyof typeof m]] as [number, number]);
    expect(weightedKappa(pairs)).toBeCloseTo(35 / 41, 10);
    expect(weightedKappa([[5, 5], [5, 5]])).toBeNull();
  });

  it('keeps n/a out of agreement and kappa, and counts it', () => {
    const gold = asm('truthfulqa', { ...g, 'des.07': 'n/a', 'des.08': 'n/a', 'des.09': 10, 'des.10': 10 });
    const r = modelMetrics(std, { truthfulqa: gold }, [pair({ ...m, 'des.07': 'n/a', 'des.08': 5, 'des.09': 'n/a' })]);
    expect(r.items).toBe(9);
    expect(r.items_missing).toBe(1);
    expect(r.na).toEqual({ both: 1, gold_only: 1, model_only: 1 });
    expect(r.numeric_items).toBe(6);
    expect(r.kappa).toBeCloseTo(35 / 41, 10);
    expect(r.exact_pct).toBeCloseTo((400 / 6), 6);
    expect(r.within5_pct).toBe(100);
    expect(r.mae).toBeCloseTo(10 / 6, 10);
  });

  it('sums usage, checks and providers; cost is n/a without usage.cost', () => {
    const t = (usage: unknown, provider?: string) => ({
      group: 'design', model: 'm', temperature: 0, seed: 1, prompt_version: '1', prompt_sha256: 'x', excerpts: [], response: null, provider, usage,
      checks: [{ item: 'des.01', proposed: 5, final: 0, quotes_kept: 1, quotes_dropped: 2, note: 'downgraded: no quote could be verified' }],
    });
    const gold = asm('truthfulqa', { 'des.01': 0 });
    const noCost = modelMetrics(std, { truthfulqa: gold }, [pair({ 'des.01': 0 }, { transcript: [t({ prompt_tokens: 10, completion_tokens: 3 }, 'DeepInfra')] })]);
    expect(noCost).toMatchObject({ input_tokens: 10, output_tokens: 3, cost_usd: 'n/a', downgraded: 1, providers: ['DeepInfra'], quote_checks: { failed: 2, total: 3 } });
    const cost = modelMetrics(std, { truthfulqa: gold }, [pair({ 'des.01': 0 }, { complete: false, transcript: [t({ prompt_tokens: 1, completion_tokens: 1, cost: 0.25 }), t({ cost: 0.5 }, 'Other')] })]);
    expect(cost.cost_usd).toBeCloseTo(0.75, 10);
    expect(cost.providers).toEqual(['Other']);
    expect(cost.pairs).toEqual({ complete: 0, incomplete: 1 });
  });

  it('leaves incomplete pairs out of every agreement metric but keeps them in calls and pair counts', () => {
    const gold = asm('truthfulqa', g);
    const check = { item: 'des.01', proposed: 0, final: 0, quotes_kept: 1, quotes_dropped: 1 };
    const t = { group: 'design', model: 'm', temperature: 0, seed: 1, prompt_version: '1', prompt_sha256: 'x', excerpts: [], response: null, usage: { prompt_tokens: 7 }, checks: [check] };
    const done = pair({ ...g });
    const bad = pair({ 'des.01': 15, 'des.02': 0, 'des.03': 0, 'des.04': 0, 'des.05': 0, 'des.06': 15, 'des.07': 'n/a' }, { complete: false, transcript: [t] });
    const alone = modelMetrics(std, { truthfulqa: gold }, [done]);
    const both = modelMetrics(std, { truthfulqa: gold }, [done, bad]);
    for (const k of ['items', 'items_missing', 'numeric_items', 'exact_pct', 'within5_pct', 'mae', 'kappa', 'na', 'overall_mad', 'quote_checks', 'downgraded'] as const) expect(both[k]).toEqual(alone[k]);
    expect(both).toMatchObject({ pairs: { complete: 1, incomplete: 1 }, calls: 8, input_tokens: 7 });
  });

  it('ranks disagreeing items', () => {
    const gold = asm('truthfulqa', { 'des.01': 0, 'des.02': 15 });
    const top = topDisagreements({ truthfulqa: gold }, { a: [pair({ 'des.01': 0, 'des.02': 0 })], b: [pair({ 'des.01': 5, 'des.02': 'n/a' })] });
    expect(top.map((d) => [d.item, d.total])).toEqual([['des.02', 15], ['des.01', 5]]);
  });
});

describe('bakeoff run', () => {
  const PAPER = 'We define truthfulness as the model avoiding false statements. The benchmark contains 817 questions spanning 38 categories.';
  const source: FetchedSource = {
    snapshot: { kind: 'paper', url: 'https://arxiv.org/abs/2109.07958v2', ref: 'v2', sha256: sha256(PAPER), chars: PAPER.length },
    chunks: chunk('paper:p1', 'p1', PAPER, 200),
  };

  it('writes pair files, report and metrics, and resumes without new calls', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async (_u, init) => {
      calls++;
      const prompt = JSON.parse(String(init!.body)).messages[0].content as string;
      const ids = [...prompt.matchAll(/^- id: (\S+)/gm)].map((x) => x[1]!);
      // first item of each group 0; the rest 5 with no quote, which the assessor downgrades to 0
      const verdicts = ids.map((item, i) => ({ item, value: i ? 5 : 0, rationale: 'r', evidence: [] }));
      return new Response(JSON.stringify({ provider: 'FakeHost', usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.001 }, choices: [{ message: { content: JSON.stringify({ verdicts }) } }] }), { status: 200 });
    };
    const out = mkdtempSync(join(tmpdir(), 'bakeoff-'));
    const opts = {
      c: corpus, models: [llmConfig(corpus, 'gpt-oss:20b')], out, date: '2026-10-27', benchmark: 'truthfulqa', maxCalls: Infinity,
      sourcesFor: async () => ({ pins: { paper_version: 'v2' }, sources: [source] }), fetchImpl,
    };
    const first = await runBakeoff(opts);
    expect(calls).toBe(4);
    expect(existsSync(join(out, 'report.md'))).toBe(true);
    expect(existsSync(join(out, 'metrics.json'))).toBe(true);
    const files = readdirSync(join(out, 'gpt-oss-20b'));
    expect(files).toEqual(['truthfulqa.json']);
    const f = JSON.parse(readFileSync(join(out, 'gpt-oss-20b/truthfulqa.json'), 'utf8')) as PairFile;
    expect(f.complete).toBe(true);
    expect(f.transcript[0]!.response).toContain('"verdicts"');
    // excerpt ids and hashes are kept; the excerpt (chunk) bodies are not
    expect(f.transcript[0]!.excerpts.length).toBeGreaterThan(0);
    for (const ch of source.chunks) expect(readFileSync(join(out, 'gpt-oss-20b/truthfulqa.json'), 'utf8')).not.toContain(ch.text.slice(0, 40));
    const mm = first.metrics['gpt-oss:20b']!;
    expect(mm).toMatchObject({ calls: 4, input_tokens: 400, providers: ['FakeHost'] });
    expect(mm.downgraded).toBeGreaterThan(0);

    await runBakeoff(opts);
    expect(calls).toBe(4);
    // an incomplete pair is re-run and overwritten
    const p = join(out, 'gpt-oss-20b/truthfulqa.json');
    writeFileSync(p, JSON.stringify({ ...f, complete: false }));
    await runBakeoff(opts);
    expect(calls).toBe(8);
    expect((JSON.parse(readFileSync(p, 'utf8')) as PairFile).complete).toBe(true);
    // a budget too small for one pair starts nothing
    const out2 = mkdtempSync(join(tmpdir(), 'bakeoff-'));
    await runBakeoff({ ...opts, out: out2, maxCalls: 3 });
    expect(calls).toBe(8);
  });

  it('records a failing pair as incomplete instead of throwing', async () => {
    const out = mkdtempSync(join(tmpdir(), 'bakeoff-'));
    await runBakeoff({
      c: corpus, models: [llmConfig(corpus, 'gpt-oss:20b')], out, date: 'd', benchmark: 'truthfulqa', maxCalls: Infinity,
      sourcesFor: async () => { throw new Error('boom'); },
    });
    const f = JSON.parse(readFileSync(join(out, 'gpt-oss-20b/truthfulqa.json'), 'utf8')) as PairFile;
    expect(f).toMatchObject({ complete: false, calls: 0, error: 'boom' });
  });
});

describe('llmConfig endpoint and key', () => {
  const VARS = ['TOUCHSTONE_LLM_BASE_URL', 'TOUCHSTONE_LLM_API_KEY', 'TOUCHSTONE_REASONING_EFFORT', 'TOUCHSTONE_THINK', 'TOUCHSTONE_MODEL'];
  const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  const reset = () => { for (const v of VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; } };
  afterEach(reset);
  const clear = () => { for (const v of VARS) delete process.env[v]; };

  it("an entry's own base_url beats the env override; the override only reaches entries without one", () => {
    clear();
    process.env.TOUCHSTONE_LLM_BASE_URL = 'http://evil.example/v1';
    process.env.TOUCHSTONE_LLM_API_KEY = 'secret-key';
    expect(llmConfig(corpus, 'openai/gpt-oss-120b').llm.baseUrl).toBe('https://openrouter.ai/api/v1');
    const local = llmConfig(corpus, 'gpt-oss:20b');
    expect(local.llm.baseUrl).toBe('http://evil.example/v1');
    expect(local.keyEnv).toBe('TOUCHSTONE_LLM_API_KEY');
  });

  it('sends no key to a local Ollama entry, and names the variable a hosted entry needs', () => {
    clear();
    process.env.TOUCHSTONE_LLM_API_KEY = 'secret-key';
    const local = llmConfig(corpus, 'gpt-oss:20b');
    expect(local.llm.baseUrl).toBe('http://localhost:11434/v1');
    expect(local.llm.apiKey).toBeUndefined();
    expect(local.keyEnv).toBeUndefined();
    const hosted = llmConfig(corpus, 'openai/gpt-oss-120b');
    expect(hosted.llm.apiKey).toBe('secret-key');
    delete process.env.TOUCHSTONE_LLM_API_KEY;
    const unset = llmConfig(corpus, 'openai/gpt-oss-120b');
    expect(unset.keyEnv).toBe('TOUCHSTONE_LLM_API_KEY');
    expect(unset.llm.apiKey).toBeUndefined();
  });

  it('drops the gpt-oss reasoning_effort default when the entry has a request block, keeps it for Ollama', () => {
    clear();
    expect(llmConfig(corpus, 'openai/gpt-oss-120b').llm).not.toHaveProperty('reasoningEffort');
    expect(llmConfig(corpus, 'gpt-oss:20b').llm.reasoningEffort).toBe('low');
    expect(llmConfig(corpus, 'qwen3:8b').llm.think).toBe(false);
  });
});

describe('bakeoff pinning and pair files', () => {
  const PAPER = 'We define truthfulness as the model avoiding false statements. The benchmark contains 817 questions spanning 38 categories.';
  const source: FetchedSource = {
    snapshot: { kind: 'paper', url: 'https://arxiv.org/abs/2109.07958v2', ref: 'v2', sha256: sha256(PAPER), chars: PAPER.length },
    chunks: chunk('paper:p1', 'p1', PAPER, 200),
  };
  const fakeFetch = (provider: string | undefined): typeof fetch => async (_u, init) => {
    const prompt = JSON.parse(String(init!.body)).messages[0].content as string;
    const ids = [...prompt.matchAll(/^- id: (\S+)/gm)].map((x) => x[1]!);
    const verdicts = ids.map((item) => ({ item, value: 0, rationale: 'r', evidence: [] }));
    return new Response(JSON.stringify({ ...(provider ? { provider } : {}), choices: [{ message: { content: JSON.stringify({ verdicts }) } }] }), { status: 200 });
  };
  const run = async (provider: string | undefined, out: string) => {
    await runBakeoff({
      c: corpus, models: [llmConfig(corpus, 'openai/gpt-oss-120b')], out, date: 'd', benchmark: 'truthfulqa', maxCalls: Infinity,
      sourcesFor: async () => ({ pins: {}, sources: [source] }), fetchImpl: fakeFetch(provider),
    });
    return JSON.parse(readFileSync(join(out, 'openai-gpt-oss-120b/truthfulqa.json'), 'utf8')) as PairFile;
  };

  it('accepts the pinned provider case-insensitively; marks other or missing providers incomplete with a reason', async () => {
    expect(await run('deepinfra', mkdtempSync(join(tmpdir(), 'bakeoff-')))).toMatchObject({ complete: true });
    const other = await run('Together', mkdtempSync(join(tmpdir(), 'bakeoff-')));
    expect(other.complete).toBe(false);
    expect(other.incomplete_reason).toMatch(/Together/);
    const none = await run(undefined, mkdtempSync(join(tmpdir(), 'bakeoff-')));
    expect(none.complete).toBe(false);
    expect(none.incomplete_reason).toMatch(/none reported/);
  });

  it('re-runs an unparseable pair file instead of aborting, and leaves no .tmp behind', async () => {
    const out = mkdtempSync(join(tmpdir(), 'bakeoff-'));
    await run('DeepInfra', out);
    const p = join(out, 'openai-gpt-oss-120b/truthfulqa.json');
    writeFileSync(p, '{"truncated": ');
    expect(await run('DeepInfra', out)).toMatchObject({ complete: true });
    expect(readdirSync(join(out, 'openai-gpt-oss-120b'))).toEqual(['truthfulqa.json']);
  });
});

describe('--max-calls validation', () => {
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  const root = new URL('..', import.meta.url).pathname;
  it.each([['assess', ['assess']], ['bakeoff', ['bakeoff', '--models', 'gpt-oss:20b']]])('%s rejects a non-positive-integer value before any call', (_n, args) => {
    for (const bad of ['0', '-1', '1.5', 'abc', '']) {
      const r = spawnSync('npx', ['tsx', cli, ...args, `--max-calls=${bad}`], { cwd: root, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('--max-calls must be a positive integer');
    }
  }, 60000);
});
