/**
 * Cross-check two model readings of the same benchmark/standard pairs and write the review rows.
 *   npx tsx scripts/crosscheck.ts --b-root <dir> --out <file>
 * A = this repo's data/assessments/<b>/<s>.auto.yaml (Gemma), B = the same files under --b-root (Qwen).
 * An item is agreed when both readings give the same value and A's quotes were verified; everything
 * else becomes a row for a person to decide. A B file that is absent, or not written by model B
 * (e.g. a copy of A), counts as B missing. Format: see rows.json in the review spec.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { load, type Corpus } from '../src/load.ts';
import type { Assessment, Evidence, Verdict } from '../src/schema.ts';

export const MODEL_A = 'google/gemma-4-31b-it';
export const MODEL_B = 'qwen/qwen3.6-35b-a3b';

export type Reason = 'values differ' | 'A quotes unverified' | 'B missing';
export interface Reading {
  value: Verdict['value'];
  rationale: string;
  evidence: { quote: string; locator: string; url: string }[];
  quotes_verified: boolean | null;
}
export interface Row {
  key: string; pair: string; benchmark: string; benchmark_title: string; standard: string; standard_title: string;
  group: string; item: string; text: string; met: string; reason: Reason; a: Reading; b: Reading | null;
}
interface Counts { items: number; agreed: number; to_review: number }
export interface Rows {
  generated_on: string; model_a: string; model_b: string;
  standards: ({ id: string; title: string; pairs: number } & Counts)[];
  pairs: ({ id: string; benchmark: string; standard: string } & Counts)[];
  rows: Row[];
}

/** Null when the readings agree, otherwise why a person must look. */
export function disagreement(a: Verdict, b: Verdict | undefined): Reason | null {
  if (!b) return 'B missing';
  if (a.value !== b.value) return 'values differ';
  if (a.quotes_verified === false) return 'A quotes unverified';
  return null;
}

const reading = (v: Verdict): Reading => ({
  value: v.value,
  rationale: v.rationale ?? '',
  evidence: v.evidence.map((e: Evidence) => ({ quote: e.quote ?? '', locator: e.locator, url: e.url })),
  quotes_verified: v.quotes_verified ?? null,
});

/** The pairs' assessments from one corpus, keyed "<benchmark>~<standard>", for one model. */
const byPair = (c: Corpus, model: string) =>
  new Map(c.assessments.filter((x) => x.value.model_run?.model === model).map((x) => [`${x.value.benchmark}~${x.value.standard}`, x.value]));

export function crosscheck(a: Corpus, b: Corpus, today = new Date().toISOString().slice(0, 10)): Rows {
  const bm = byPair(b, MODEL_B);
  const titles = new Map(a.benchmarks.map((x) => [x.value.id, x.value.name]));
  const out: Rows = { generated_on: today, model_a: MODEL_A, model_b: MODEL_B, standards: [], pairs: [], rows: [] };
  for (const [id, av] of [...byPair(a, MODEL_A)].sort(([x], [y]) => x.localeCompare(y))) {
    const std = a.standards.find((s) => s.value.id === av.standard)?.value;
    if (!std) continue;
    const bv: Assessment | undefined = bm.get(id);
    const pair = { id, benchmark: av.benchmark, standard: av.standard, items: 0, agreed: 0, to_review: 0 };
    for (const g of std.groups)
      for (const it of g.items) {
        const va = av.verdicts?.[it.id];
        if (!va) continue;
        pair.items++;
        const vb = bv?.verdicts?.[it.id];
        const reason = disagreement(va, vb);
        if (!reason) { pair.agreed++; continue; }
        pair.to_review++;
        out.rows.push({
          key: `${id}~${it.id}`, pair: id, benchmark: av.benchmark, benchmark_title: titles.get(av.benchmark) ?? av.benchmark,
          standard: std.id, standard_title: std.name, group: g.name, item: it.id, text: it.text, met: it.guidance?.met ?? '',
          reason, a: reading(va), b: vb ? reading(vb) : null,
        });
      }
    out.pairs.push(pair);
  }
  for (const s of a.standards) {
    const ps = out.pairs.filter((p) => p.standard === s.value.id);
    if (!ps.length) continue;
    const sum = (k: keyof Counts) => ps.reduce((n, p) => n + p[k], 0);
    out.standards.push({ id: s.value.id, title: s.value.name, pairs: ps.length, items: sum('items'), agreed: sum('agreed'), to_review: sum('to_review') });
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values } = parseArgs({ options: { 'b-root': { type: 'string' }, out: { type: 'string' } } });
  if (!values['b-root'] || !values.out) { console.error('usage: crosscheck.ts --b-root <dir> --out <file>'); process.exit(1); }
  const root = new URL('..', import.meta.url).pathname;
  const rows = crosscheck(load(root), load(resolve(values['b-root'])));
  mkdirSync(dirname(resolve(values.out)), { recursive: true });
  writeFileSync(resolve(values.out), JSON.stringify(rows, null, 1) + '\n');
  const t = (k: keyof Counts) => rows.pairs.reduce((n, p) => n + p[k], 0);
  console.log(`${rows.pairs.length} pairs, ${t('items')} items, ${t('agreed')} agreed, ${t('to_review')} to review -> ${values.out}`);
  for (const s of rows.standards) console.log(`  ${s.id}: ${s.pairs} pairs, ${s.items} items, ${s.agreed} agreed, ${s.to_review} to review`);
}
