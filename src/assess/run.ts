/**
 * Automated assessment of one benchmark against one standard.
 *
 * The model only proposes verdicts. Everything around the call is deterministic: which excerpts it
 * sees (BM25 over pinned sources), the prompt, and the post-processing that verifies quotes and
 * downgrades unsupported verdicts. Every call is logged to the transcript so the run can be audited
 * and, with the same model and sources, repeated.
 */
import { readFileSync } from 'node:fs';
import type { Assessment, Benchmark, Evidence, Group, Item, SourceSnapshot, Standard, Verdict } from '../schema.ts';
import { chat, parseJson, type LlmConfig } from './llm.ts';
import { rank, sha256, verifyQuote, type Chunk } from './text.ts';
import type { FetchedSource } from './sources.ts';

const PROMPT_PATH = new URL('../../prompts/assess-group.md', import.meta.url);
export const promptTemplate = () => readFileSync(PROMPT_PATH, 'utf8');
export const promptVersion = (tpl: string) => tpl.match(/prompt_version:\s*(\S+)/)?.[1] ?? 'unknown';

export interface TranscriptEntry {
  group: string;
  model: string;
  temperature: number;
  seed: number;
  prompt_version: string;
  /** false when the model's thinking mode was switched off for this call. */
  think?: boolean;
  prompt_sha256: string;
  /** Excerpt ids shown to the model; with the pinned sources they reconstruct the prompt exactly. */
  excerpts: string[];
  response: string | null;
  reasoning?: string;
  /** Wall-clock time of the model call, in milliseconds. */
  ms?: number;
  error?: string;
  checks: { item: string; proposed: unknown; final: unknown; quotes_kept: number; quotes_dropped: number; note?: string }[];
}

/** Excerpts for a group: each item's top 3 chunks, merged in item order, then the group's own top chunks, within a size budget. */
export function selectExcerpts(group: Group, chunks: Chunk[], budget = 10_000): Chunk[] {
  const picked: Chunk[] = [];
  const seen = new Set<string>();
  const add = (c: Chunk) => { if (!seen.has(c.id)) { seen.add(c.id); picked.push(c); } };
  for (const it of group.items) for (const c of rank(chunks, `${it.text} ${it.guidance?.met ?? ''}`, 3)) add(c);
  for (const c of rank(chunks, group.items.map((i) => i.text).join(' '), 6)) add(c);
  const out: Chunk[] = [];
  let used = 0;
  for (const c of picked) {
    if (used + c.text.length > budget) continue;
    out.push(c);
    used += c.text.length;
  }
  return out;
}

function vocabulary(std: Standard) {
  const s = std.scoring!;
  if (s.scheme === 'points') {
    const top = Math.max(...s.levels);
    return { allowed: [...s.levels.map(String), '"n/a"'].join(', '), positive: `any level above 0`, negative: '0', levels: s.levels, top, meanings: s.level_meanings };
  }
  return { allowed: '"met", "unmet", "n/a"', positive: 'met', negative: 'unmet', levels: undefined, top: undefined, meanings: undefined };
}

export function renderPrompt(tpl: string, b: Benchmark, std: Standard, g: Group, excerpts: Chunk[]): string {
  const voc = vocabulary(std);
  const items = g.items.map((it) => [
    `- id: ${it.id}`,
    it.principle ? `  principle: ${it.principle}` : '',
    `  item: ${it.text}`,
    `  decision rule (met when): ${it.guidance?.met ?? it.text}`,
    it.guidance?.not_applicable ? `  n/a when: ${it.guidance.not_applicable}` : '  n/a: not allowed for this item',
  ].filter(Boolean).join('\n')).join('\n');
  const meanings = voc.meanings
    ? '6. Levels mean: ' + Object.entries(voc.meanings).sort((a, b) => Number(b[0]) - Number(a[0])).map(([k, v]) => `${k} = ${v}`).join(' ') + '\n'
    : '';
  const ex = excerpts.map((c) => `[${c.id}] (${c.locator})\n${c.text}`).join('\n\n---\n\n');
  return tpl
    .replace(/^<!--.*-->\n/gm, '')
    .replaceAll('{{benchmark}}', b.name)
    .replaceAll('{{standard}}', std.name)
    .replaceAll('{{group}}', g.name)
    .replaceAll('{{allowed_values}}', voc.allowed)
    .replaceAll('{{positive}}', voc.positive)
    .replaceAll('{{negative}}', voc.negative)
    .replaceAll('{{level_meanings}}', meanings)
    .replaceAll('{{items}}', items)
    .replaceAll('{{excerpts}}', ex || '(no excerpts matched; every item is therefore unmet unless an n/a condition is shown)');
}

/**
 * Deterministic post-processing of one proposed verdict:
 *  - quotes are kept only if found verbatim (after normalisation) in the excerpt they cite;
 *  - a positive verdict with no verified quote becomes negative;
 *  - n/a on an item with no n/a condition becomes negative;
 *  - anything unparseable is left out, and the engine scores it as unmet.
 */
export function finalize(std: Standard, item: Item, raw: unknown, shown: Map<string, Chunk>, snapshots: Map<string, SourceSnapshot>): { verdict?: Verdict; check: TranscriptEntry['checks'][number] } {
  const voc = vocabulary(std);
  const r = (raw ?? {}) as { value?: unknown; rationale?: unknown; evidence?: unknown };
  const proposed = r.value;
  const rationale = typeof r.rationale === 'string' ? r.rationale.trim() : '';
  let value: Verdict['value'] | undefined;
  if (voc.levels) {
    const n = typeof proposed === 'string' && proposed !== 'n/a' ? Number(proposed) : proposed;
    if (n === 'n/a') value = 'n/a';
    else if (typeof n === 'number' && voc.levels.includes(n)) value = n;
  } else if (proposed === 'met' || proposed === 'unmet' || proposed === 'n/a') value = proposed;
  if (value === undefined) return { check: { item: item.id, proposed, final: null, quotes_kept: 0, quotes_dropped: 0, note: 'value not allowed; left out (scored as unmet)' } };

  const evidence: Evidence[] = [];
  let dropped = 0;
  for (const e of Array.isArray(r.evidence) ? r.evidence : []) {
    const { excerpt, quote } = (e ?? {}) as { excerpt?: unknown; quote?: unknown };
    const c = typeof excerpt === 'string' ? shown.get(excerpt) : undefined;
    if (!c || typeof quote !== 'string' || quote.split(/\s+/).length > 40 || !verifyQuote(quote, c.text)) { dropped++; continue; }
    const snap = snapshots.get(c.source.split(':')[0]!)!;
    evidence.push({ source: snap.kind, url: snap.url, locator: c.locator, quote: quote.trim() });
  }

  const negative: Verdict['value'] = voc.levels ? 0 : 'unmet';
  const positive = value !== 'n/a' && value !== negative && value !== 'unmet';
  let note: string | undefined;
  let finalValue = value;
  let finalRationale = rationale;
  if (positive && evidence.length === 0) {
    finalValue = negative;
    note = 'downgraded: no quote could be verified';
    finalRationale = `No quote supporting this could be verified in the sources, so it is scored as not satisfied. Model's proposal (${String(value)}): ${rationale}`;
  } else if (value === 'n/a' && !item.guidance?.not_applicable) {
    finalValue = negative;
    note = 'downgraded: item has no n/a condition';
    finalRationale = `This item has no n/a condition, so n/a is not allowed. Model's reasoning: ${rationale}`;
  }
  return {
    verdict: { value: finalValue, rationale: finalRationale || undefined, evidence, by: 'model', quotes_verified: true },
    check: { item: item.id, proposed, final: finalValue, quotes_kept: evidence.length, quotes_dropped: dropped, note },
  };
}

export interface RunInput {
  benchmark: Benchmark;
  standard: Standard;
  sources: FetchedSource[];
  llm: LlmConfig;
  provider: string;
  license: string;
  modelDigest?: string;
  runOn: string;
  transcriptPath: string;
  pins: { paper_version?: string; repo_commit?: string };
  fetchImpl?: typeof fetch;
  /** Stop before this many model calls (free-tier budgets); remaining groups are left out. */
  maxCalls?: number;
}

export async function assess(input: RunInput): Promise<{ assessment: Assessment; transcript: TranscriptEntry[]; calls: number; complete: boolean }> {
  const { benchmark: b, standard: std, llm } = input;
  const tpl = promptTemplate();
  const version = promptVersion(tpl);
  const chunks = input.sources.flatMap((s) => s.chunks);
  const snapshots = new Map(input.sources.map((s) => [s.snapshot.kind, s.snapshot]));
  const verdicts: Record<string, Verdict> = {};
  const transcript: TranscriptEntry[] = [];
  let calls = 0;
  let complete = true;

  for (const g of std.groups) {
    if (input.maxCalls !== undefined && calls >= input.maxCalls) { complete = false; break; }
    const excerpts = selectExcerpts(g, chunks);
    const prompt = renderPrompt(tpl, b, std, g, excerpts);
    const entry: TranscriptEntry = {
      group: g.id, model: llm.model, temperature: llm.temperature, seed: llm.seed, prompt_version: version,
      ...(llm.think !== undefined ? { think: llm.think } : {}),
      prompt_sha256: sha256(prompt), excerpts: excerpts.map((c) => c.id), response: null, checks: [],
    };
    transcript.push(entry);
    calls++;
    let parsed: { verdicts?: unknown[] } | undefined;
    try {
      const started = Date.now();
      const res = await chat(llm, [{ role: 'user', content: prompt }], input.fetchImpl);
      entry.ms = Date.now() - started;
      entry.response = res.content;
      if (res.reasoning) entry.reasoning = res.reasoning;
      parsed = parseJson(res.content) as { verdicts?: unknown[] };
    } catch (e) {
      entry.error = (e as Error).message;
      complete = false;
      if ((e as Error).name === 'RateLimited' || /rate limited/.test(entry.error)) break;
      continue;
    }
    const byItem = new Map<string, unknown>();
    for (const v of Array.isArray(parsed?.verdicts) ? parsed!.verdicts : []) {
      const id = (v as { item?: unknown })?.item;
      if (typeof id === 'string' && !byItem.has(id)) byItem.set(id, v);
    }
    const shown = new Map(excerpts.map((c) => [c.id, c]));
    for (const it of g.items) {
      const { verdict, check } = finalize(std, it, byItem.get(it.id), shown, snapshots);
      entry.checks.push(check);
      if (verdict) verdicts[it.id] = verdict;
      else complete = false;
    }
  }

  const assessment: Assessment = {
    benchmark: b.id,
    standard: std.id,
    standard_version: std.version,
    status: 'draft',
    mode: 'itemized',
    provenance: { kind: 'automated', assessors: [`touchstone-assessor (${llm.model})`], assessed_on: input.runOn },
    benchmark_ref: { ...(input.pins.paper_version ? { paper_version: input.pins.paper_version } : {}), ...(input.pins.repo_commit ? { repo_commit: input.pins.repo_commit } : {}) },
    model_run: {
      model: llm.model, provider: input.provider, license: input.license,
      ...(input.modelDigest ? { model_digest: input.modelDigest } : {}),
      temperature: llm.temperature, seed: llm.seed,
      prompt_version: version, run_on: input.runOn, transcript: input.transcriptPath, sources: input.sources.map((s) => s.snapshot),
    },
    verdicts,
    revisions: [{ date: input.runOn, by: 'touchstone-assessor', summary: complete ? `Automated assessment with ${llm.model}.` : `Partial automated assessment with ${llm.model}; some groups or items were not completed.` }],
  };
  return { assessment, transcript, calls, complete };
}
