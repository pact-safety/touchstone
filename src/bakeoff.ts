/**
 * Bake-off: run candidate models on the benchmarks BetterBench assessed by hand, and score each model's
 * verdicts against BetterBench's. `modelMetrics` and `topDisagreements` are pure; `runBakeoff` does the I/O.
 *
 * Pair files hold verdict values plus the transcript as data/runs does (raw replies and reasoning verbatim,
 * excerpt ids, hashes, usage). Excerpt text itself is never written.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Corpus } from './load.ts';
import type { Assessment, Benchmark, Standard, Verdict } from './schema.ts';
import { score } from './engine.ts';
import { assess, type TranscriptEntry } from './assess/run.ts';
import type { LlmConfig } from './assess/llm.ts';
import type { Pins, FetchedSource } from './assess/sources.ts';

export const STANDARD = 'betterbench';
export const LEVELS = [0, 5, 10, 15];

type Value = Verdict['value'];
type CI = [number, number] | null;
export interface PairFile {
  model: string;
  benchmark: string;
  standard: string;
  date: string;
  complete: boolean;
  calls: number;
  error?: string;
  /** Why a pair that otherwise finished was marked incomplete (e.g. served by an unpinned provider). */
  incomplete_reason?: string;
  verdicts: Record<string, Value>;
  transcript: TranscriptEntry[];
}

export interface ModelMetrics {
  /** Gold items for which the model gave a verdict / gold items it left without one. */
  items: number;
  items_missing: number;
  /** Items where both gold and model gave a number; the three figures below use only these. */
  numeric_items: number;
  exact_pct: number | null;
  within5_pct: number | null;
  mae: number | null;
  /** Quadratic-weighted Cohen's kappa over 0/5/10/15; null when undefined (no items, or no variation to measure). */
  kappa: number | null;
  /** Mean (model - gold) in points over the numeric items; negative = the model scores lower than BetterBench. */
  bias: number | null;
  /** Benchmark-level cluster bootstrap 95% CIs (resample benchmarks, not items). */
  ci: { kappa: CI; mae: CI; exact_pct: CI };
  /** 95% CI of (this kappa - the top model's kappa) on the same resamples; null for the top model. Set by runBakeoff. */
  kappa_vs_top: CI;
  na: { both: number; gold_only: number; model_only: number };
  /** Mean |engine overall(model) - engine overall(gold)| over complete pairs. */
  overall_mad: number | null;
  quote_checks: { failed: number; total: number };
  downgraded: number;
  pairs: { complete: number; incomplete: number };
  calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | 'n/a';
  providers: string[];
}

const pct = (n: number, d: number) => (d ? (100 * n) / d : null);
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);

/** Quadratic-weighted Cohen's kappa: 1 - sum(w*observed) / sum(w*expected), w = squared distance between levels. */
export function weightedKappa(pairs: [number, number][], levels = LEVELS): number | null {
  const n = pairs.length;
  if (!n) return null;
  const k = levels.length;
  const rows = Array(k).fill(0), cols = Array(k).fill(0);
  let obs = 0;
  for (const [g, m] of pairs) {
    const i = levels.indexOf(g), j = levels.indexOf(m);
    rows[i]++; cols[j]++;
    obs += (i - j) ** 2;
  }
  let exp = 0;
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) exp += (i - j) ** 2 * rows[i] * cols[j] / n;
  return exp === 0 ? null : 1 - obs / exp;
}

type ByBench = Record<string, [number, number][]>;
const BOOTSTRAP_REPLICATES = 2000;
const BOOTSTRAP_SEED = 20261028;

/** Small seeded PRNG so the bootstrap is reproducible. */
function mulberry32(a: number) {
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** [gold, model] numeric pairs per benchmark, complete pairs only. */
function numericByBench(gold: Record<string, Assessment>, pairs: PairFile[]): ByBench {
  const out: ByBench = {};
  for (const p of pairs) {
    if (!p.complete || !gold[p.benchmark]) continue;
    for (const [id, gv] of Object.entries(gold[p.benchmark]!.verdicts ?? {})) {
      const mv = p.verdicts[id];
      if (LEVELS.includes(gv.value as number) && LEVELS.includes(mv as number)) (out[p.benchmark] ??= []).push([gv.value as number, mv as number]);
    }
  }
  return out;
}
const pool = (by: ByBench, draw: string[]) => draw.flatMap((b) => by[b] ?? []);

/**
 * Percentile 95% CI of `stat` over benchmark resamples. The same seed and ids give the same draws for every
 * caller, so two models' statistics are compared on identical resamples. shortcut: replicates where stat is null are dropped.
 */
export function bootstrap(ids: string[], stat: (draw: string[]) => number | null): CI {
  if (!ids.length) return null;
  const rnd = mulberry32(BOOTSTRAP_SEED);
  const vals: number[] = [];
  for (let r = 0; r < BOOTSTRAP_REPLICATES; r++) {
    const v = stat(ids.map(() => ids[Math.floor(rnd() * ids.length)]!));
    if (v !== null) vals.push(v);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * vals.length)]!, vals[Math.ceil(0.975 * vals.length) - 1]!];
}

/** The model with the highest point-estimate kappa (first on ties); undefined when none has one. */
export const topModel = (metrics: Record<string, ModelMetrics>) =>
  Object.entries(metrics).filter(([, m]) => m.kappa !== null).sort((a, b) => b[1].kappa! - a[1].kappa!)[0]?.[0];

/** Per model, the CI of (its kappa - the top model's kappa) on shared benchmark resamples; null for the top model. */
export function kappaVsTop(gold: Record<string, Assessment>, byModel: Record<string, PairFile[]>, metrics: Record<string, ModelMetrics>): Record<string, CI> {
  const top = topModel(metrics);
  const by = Object.fromEntries(Object.entries(byModel).map(([id, ps]) => [id, numericByBench(gold, ps)]));
  return Object.fromEntries(Object.keys(byModel).map((id) => [id, id === top || !top ? null : bootstrap(Object.keys(gold).sort(), (d) => {
    const a = weightedKappa(pool(by[id]!, d)), b = weightedKappa(pool(by[top]!, d));
    return a === null || b === null ? null : a - b;
  })]));
}

export function modelMetrics(std: Standard, gold: Record<string, Assessment>, pairs: PairFile[]): ModelMetrics {
  const m: ModelMetrics = {
    items: 0, items_missing: 0, numeric_items: 0, exact_pct: null, within5_pct: null, mae: null, kappa: null, bias: null,
    ci: { kappa: null, mae: null, exact_pct: null }, kappa_vs_top: null,
    na: { both: 0, gold_only: 0, model_only: 0 }, overall_mad: null, quote_checks: { failed: 0, total: 0 }, downgraded: 0,
    pairs: { complete: 0, incomplete: 0 }, calls: 0, input_tokens: null, output_tokens: null, cost_usd: 'n/a', providers: [],
  };
  const numeric: [number, number][] = [];
  const diffs: number[] = [];
  const providers = new Set<string>();
  let cost: number | undefined;
  for (const p of pairs) {
    m.pairs[p.complete ? 'complete' : 'incomplete']++;
    m.calls += p.calls;
    // Incomplete pairs count toward pairs, calls, tokens, cost and providers only, never toward agreement figures.
    const g = p.complete ? gold[p.benchmark] : undefined;
    if (g) {
      for (const [id, gv] of Object.entries(g.verdicts ?? {})) {
        const mv = p.verdicts[id];
        if (mv === undefined) { m.items_missing++; continue; }
        m.items++;
        if (gv.value === 'n/a' || mv === 'n/a') {
          if (gv.value === 'n/a' && mv === 'n/a') m.na.both++;
          else if (gv.value === 'n/a') m.na.gold_only++;
          else m.na.model_only++;
        } else if (LEVELS.includes(gv.value as number) && LEVELS.includes(mv as number)) numeric.push([gv.value as number, mv as number]);
      }
      {
        const model = score(std, { ...g, verdicts: Object.fromEntries(Object.entries(p.verdicts).map(([id, value]) => [id, { value, evidence: [], by: 'model' }])) } as Assessment).overall.score;
        const gs = score(std, g).overall.score;
        if (model !== null && gs !== null) diffs.push(Math.abs(model - gs));
      }
    }
    for (const t of p.transcript) {
      if (t.provider) providers.add(t.provider);
      const u = (t.usage ?? {}) as Record<string, unknown>;
      const inp = num(u.prompt_tokens) ?? num(u.input_tokens), out = num(u.completion_tokens) ?? num(u.output_tokens);
      if (inp !== undefined) m.input_tokens = (m.input_tokens ?? 0) + inp;
      if (out !== undefined) m.output_tokens = (m.output_tokens ?? 0) + out;
      const c = num(u.cost) ?? num(u.estimated_cost); // DeepInfra's direct API reports estimated_cost
      if (c !== undefined) cost = (cost ?? 0) + c;
      for (const c of p.complete ? t.checks : []) {
        m.quote_checks.failed += c.quotes_dropped;
        m.quote_checks.total += c.quotes_kept + c.quotes_dropped;
        if (c.note?.startsWith('downgraded: no quote')) m.downgraded++;
      }
    }
  }
  m.numeric_items = numeric.length;
  m.exact_pct = pct(numeric.filter(([a, b]) => a === b).length, numeric.length);
  m.within5_pct = pct(numeric.filter(([a, b]) => Math.abs(a - b) <= 5).length, numeric.length);
  m.mae = numeric.length ? numeric.reduce((s, [a, b]) => s + Math.abs(a - b), 0) / numeric.length : null;
  m.kappa = weightedKappa(numeric);
  m.bias = numeric.length ? numeric.reduce((s, [g, v]) => s + (v - g), 0) / numeric.length : null;
  const by = numericByBench(gold, pairs);
  const stats = {
    kappa: (d: string[]) => weightedKappa(pool(by, d)),
    mae: (d: string[]) => { const x = pool(by, d); return x.length ? x.reduce((s, [a, b]) => s + Math.abs(a - b), 0) / x.length : null; },
    exact_pct: (d: string[]) => { const x = pool(by, d); return pct(x.filter(([a, b]) => a === b).length, x.length); },
  };
  for (const k of ['kappa', 'mae', 'exact_pct'] as const) m.ci[k] = bootstrap(Object.keys(gold).sort(), stats[k]);
  m.overall_mad = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null;
  m.cost_usd = cost ?? 'n/a';
  m.providers = [...providers].sort();
  return m;
}

export interface Disagreement { benchmark: string; item: string; gold: number; models: Record<string, number | 'n/a'>; total: number }

/** Items with the largest summed |model - gold| (points) across models; numeric gold only, models with no verdict skipped. */
export function topDisagreements(gold: Record<string, Assessment>, byModel: Record<string, PairFile[]>, n = 10): Disagreement[] {
  const rows = new Map<string, Disagreement>();
  for (const [model, pairs] of Object.entries(byModel)) {
    for (const p of pairs) {
      for (const [id, gv] of Object.entries(gold[p.benchmark]?.verdicts ?? {})) {
        const mv = p.verdicts[id];
        if (typeof gv.value !== 'number' || mv === undefined) continue;
        const key = `${p.benchmark}/${id}`;
        const r = rows.get(key) ?? { benchmark: p.benchmark, item: id, gold: gv.value, models: {}, total: 0 };
        r.models[model] = mv as number | 'n/a';
        if (typeof mv === 'number') r.total += Math.abs(mv - gv.value);
        rows.set(key, r);
      }
    }
  }
  return [...rows.values()].sort((a, b) => b.total - a.total || `${a.benchmark}/${a.item}`.localeCompare(`${b.benchmark}/${b.item}`)).slice(0, n);
}

const f = (x: number | null, d = 1) => (x === null ? 'n/a' : x.toFixed(d));
const ci = (x: CI, d = 1) => (x === null ? 'n/a' : `[${x[0].toFixed(d)}, ${x[1].toFixed(d)}]`);

export function renderReport(date: string, metrics: Record<string, ModelMetrics>, dis: Disagreement[]): string {
  const ids = Object.keys(metrics);
  const top = topModel(metrics);
  const row = (label: string, g: (m: ModelMetrics, id: string) => string) => `| ${label} | ${ids.map((i) => g(metrics[i]!, i)).join(' | ')} |`;
  const lines = [
    `# Bake-off against BetterBench, ${date}`,
    '',
    'Each model assessed the benchmarks BetterBench scored by hand; its verdicts are compared with BetterBench\'s. Agreement, MAE and kappa use only items where both gave a number; n/a is counted separately.',
    '',
    `| | ${ids.join(' | ')} |`,
    `|---|${ids.map(() => '---').join('|')}|`,
    row('items compared (missing)', (m) => `${m.items} (${m.items_missing})`),
    row('numeric items', (m) => `${m.numeric_items}`),
    row('exact agreement %', (m) => f(m.exact_pct)),
    row('within 5 points %', (m) => f(m.within5_pct)),
    row('MAE (points)', (m) => f(m.mae, 2)),
    row('quadratic kappa', (m) => f(m.kappa, 3)),
    row('kappa 95% CI', (m) => ci(m.ci.kappa, 3)),
    row('MAE 95% CI', (m) => ci(m.ci.mae, 2)),
    row('exact % 95% CI', (m) => ci(m.ci.exact_pct)),
    row('bias (model − gold, points)', (m) => f(m.bias, 2)),
    row('kappa vs top (95% CI)', (m, i) => (i === top ? '—' : ci(m.kappa_vs_top, 3))),
    row('n/a: both / gold only / model only', (m) => `${m.na.both} / ${m.na.gold_only} / ${m.na.model_only}`),
    row('overall score mean abs diff', (m) => f(m.overall_mad, 2)),
    row('quote checks failed', (m) => `${m.quote_checks.failed} / ${m.quote_checks.total}`),
    row('verdicts downgraded (no quote)', (m) => `${m.downgraded}`),
    row('pairs complete / incomplete', (m) => `${m.pairs.complete} / ${m.pairs.incomplete}`),
    row('calls', (m) => `${m.calls}`),
    row('input tokens', (m) => (m.input_tokens === null ? 'n/a' : `${m.input_tokens}`)),
    row('output tokens', (m) => (m.output_tokens === null ? 'n/a' : `${m.output_tokens}`)),
    row('cost ($)', (m) => (m.cost_usd === 'n/a' ? 'n/a' : m.cost_usd.toFixed(4))),
    row('providers', (m) => m.providers.join(', ') || 'n/a'),
    '',
    'The 95% CIs resample benchmarks (2000 draws, fixed seed), not items, because items within a benchmark are not independent; "kappa vs top" is the CI of the difference from the highest-kappa model on the same resamples.',
    '',
    '## Items with the most disagreement',
    '',
    `| benchmark | item | BetterBench | ${ids.join(' | ')} | total abs diff |`,
    `|---|---|---|${ids.map(() => '---').join('|')}|---|`,
    ...dis.map((d) => `| ${d.benchmark} | ${d.item} | ${d.gold} | ${ids.map((i) => d.models[i] ?? '-').join(' | ')} | ${d.total} |`),
    '',
  ];
  return lines.join('\n');
}

export interface BakeoffOptions {
  c: Corpus;
  models: { entry: { provider: string; license: string }; llm: LlmConfig }[];
  out: string;
  date: string;
  benchmark?: string;
  maxCalls: number;
  sourcesFor: (b: Benchmark) => Promise<{ pins: Pins; sources: FetchedSource[] }>;
  /** Test seam: replaces the network for model calls. */
  fetchImpl?: typeof fetch;
  /** Test seam: replaces the real wait between rate-limit retries. */
  sleep?: (ms: number) => Promise<void>;
  log?: (s: string) => void;
}

export const slug = (model: string) => model.replace(/[^A-Za-z0-9._-]+/g, '-');
// Atomic: a crash mid-write leaves the old file, never a truncated one.
const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(`${path}.tmp`, text); renameSync(`${path}.tmp`, path); };

/** The pair file at `path`, or undefined if absent or unparseable (an unreadable pair is simply re-run). */
const readPair = (path: string): PairFile | undefined => {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, 'utf8')) as PairFile; } catch { return undefined; }
};

/** Providers named by `request.provider.only`, lower-cased; undefined when the entry is not pinned. */
const pinnedProviders = (extra?: Record<string, unknown>): string[] | undefined => {
  const only = (extra?.provider as { only?: unknown } | undefined)?.only;
  return Array.isArray(only) && only.length ? only.map((x) => String(x).toLowerCase()) : undefined;
};

/** BetterBench's hand assessments: external provenance, itemized, with a benchmark entry to fetch sources for. */
export function goldAssessments(c: Corpus, only?: string): Assessment[] {
  return c.assessments.map((a) => a.value).filter((a) => a.standard === STANDARD && a.provenance.kind === 'external' && a.mode === 'itemized' && (!only || a.benchmark === only));
}

export async function runBakeoff(o: BakeoffOptions) {
  const log = o.log ?? (() => {});
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const std = o.c.standards.find((s) => s.value.id === STANDARD)!.value;
  const golds = goldAssessments(o.c, o.benchmark);
  if (!golds.length) throw new Error(o.benchmark ? `No BetterBench gold assessment for "${o.benchmark}".` : 'No BetterBench gold assessments found.');
  const goldBy = Object.fromEntries(golds.map((g) => [g.benchmark, g]));
  const pairPath = (model: string, bench: string) => join(o.out, slug(model), `${bench}.json`);
  let used = 0;
  let budgetHit = false;
  for (const g of golds) {
    if (budgetHit) break;
    const b = o.c.benchmarks.find((x) => x.value.id === g.benchmark)!.value;
    let src: Awaited<ReturnType<BakeoffOptions['sourcesFor']>> | undefined;
    for (const { entry, llm } of o.models) {
      const path = pairPath(llm.model, b.id);
      // Only a complete pair is final; an incomplete one is re-run and its file overwritten.
      if (readPair(path)?.complete) continue;
      // A pair needs one call per group; never start one the budget can't finish.
      if (used + std.groups.length > o.maxCalls) { budgetHit = true; log(`call budget reached; rerun the same command to continue`); break; }
      const file: PairFile = { model: llm.model, benchmark: b.id, standard: STANDARD, date: o.date, complete: false, calls: 0, verdicts: {}, transcript: [] };
      try {
        src ??= await o.sourcesFor(b);
        if (!src.sources.length) throw new Error('no paper or repo to read');
        // A rate-limited pair waits and retries (30s, 60s, 120s); retries spend budget like any call.
        for (let retry = 0; ; retry++) {
          const run = await assess({
            benchmark: b, standard: std, sources: src.sources, llm, provider: entry.provider, license: entry.license, runOn: o.date,
            transcriptPath: path, pins: { paper_version: src.pins.paper_version, repo_commit: src.pins.repo_commit }, fetchImpl: o.fetchImpl,
          });
          file.calls += run.calls;
          used += run.calls;
          file.verdicts = Object.fromEntries(Object.entries(run.assessment.verdicts ?? {}).map(([id, v]) => [id, v.value]));
          file.transcript = run.transcript;
          // Omitted items and unparseable replies are model-quality outcomes (counted as missing); only an unanswered call is incomplete.
          file.complete = std.groups.every((gr) => run.transcript.some((e) => e.group === gr.id && e.response !== null));
          const errs = [...new Set(run.transcript.map((e) => e.error).filter(Boolean))];
          file.error = errs.length ? errs.join(' | ').slice(0, 300) : undefined;
          if (file.complete || retry >= 3 || !errs.some((e) => /rate limited/.test(e!)) || used + std.groups.length > o.maxCalls) break;
          log(`${llm.model} × ${b.id}: rate limited; retry ${retry + 1} of 3 after ${30 * 2 ** retry}s`);
          await sleep(30000 * 2 ** retry);
        }
        // A pinned entry must have been served only by its pinned provider(s); a missing provider field is a mismatch.
        const pins = pinnedProviders(llm.extra);
        const bad = pins ? [...new Set(file.transcript.filter((e) => e.response !== null).map((e) => e.provider ?? '(none reported)').filter((p) => !pins.includes(p.toLowerCase())))] : [];
        if (bad.length) { file.complete = false; file.incomplete_reason = `served by unpinned provider(s) ${bad.join(', ')}; pinned to ${pins!.join(', ')}`; }
        // OpenRouter-style dated suffixes still match; a missing served_model (older files, some endpoints) is not a mismatch.
        const want = llm.model.toLowerCase();
        const wrong = [...new Set(file.transcript.filter((e) => e.response !== null && e.served_model && !e.served_model.toLowerCase().startsWith(want)).map((e) => e.served_model!))];
        if (wrong.length && file.complete) { file.complete = false; file.incomplete_reason = `served by a different model: ${wrong.join(', ')}; requested ${llm.model}`; }
      } catch (e) {
        file.error = (e as Error).message.slice(0, 300);
      }
      write(path, JSON.stringify(file, null, 1) + '\n');
      log(`${llm.model} × ${b.id}: ${file.complete ? 'complete' : `INCOMPLETE${file.error || file.incomplete_reason ? ` (${file.incomplete_reason ?? file.error})` : ''}`}, ${file.calls} call(s)`);
    }
  }
  // Report from everything on disk, so a resumed run reports the whole bake-off.
  const byModel: Record<string, PairFile[]> = {};
  for (const { llm } of o.models) {
    byModel[llm.model] = golds.flatMap((g) => readPair(pairPath(llm.model, g.benchmark)) ?? []);
  }
  const metrics = Object.fromEntries(Object.entries(byModel).map(([id, ps]) => [id, modelMetrics(std, goldBy, ps)]));
  for (const [id, v] of Object.entries(kappaVsTop(goldBy, byModel, metrics))) metrics[id]!.kappa_vs_top = v;
  const dis = topDisagreements(goldBy, byModel);
  write(join(o.out, 'metrics.json'), JSON.stringify({ date: o.date, standard: STANDARD, benchmarks: golds.map((g) => g.benchmark), models: metrics, top_disagreements: dis }, null, 1) + '\n');
  write(join(o.out, 'report.md'), renderReport(o.date, metrics, dis));
  log(`${used} call(s) used; wrote ${join(o.out, 'report.md')}`);
  return { metrics, dis, used };
}
