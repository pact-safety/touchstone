/**
 * Build the site's data files: a small index plus one file per benchmark and per standard. Output depends only on the repository contents (no clock), so the
 * same commit always produces byte-identical JSON.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Assessment, Benchmark, Standard } from './schema.ts';
import type { Corpus } from './load.ts';
import { improvements, score, type Improvement, type Result } from './engine.ts';
import type { WatchState } from './watch.ts';
import { frontier, rigor, rigorInputs, runProfile, type Pricing, type TouchstoneData } from './touchstone.ts';

export const REPO_URL = 'https://github.com/pact-safety/touchstone';

export interface Summary {
  benchmark: string;
  standard: string;
  file: string;
  status: Assessment['status'];
  kind: Assessment['provenance']['kind'];
  model: string | null;
  label: string;
  pct: number | null;
  discrepancies: number;
}
export type IndexStandard = Omit<Standard, 'groups'>;
const PricingSchema = z.strictObject({ as_of: z.string(), low_usd_per_mtok: z.number().positive(), high_usd_per_mtok: z.number().positive() });
export type BenchmarkFile = { id: string; touchstone: TouchstoneData; assessments: (Assessment & { file: string })[]; results: (Result & { file: string; improvements: Improvement[] })[] };

export function buildSiteData(c: Corpus) {
  const standards = new Map(c.standards.map((s) => [s.value.id, s.value]));
  const results: (Result & { file: string; improvements: Improvement[] })[] = [];
  for (const { path, value: a } of c.assessments) {
    const s = standards.get(a.standard);
    if (!s || s.status !== 'encoded') continue;
    results.push({ ...score(s, a), improvements: improvements(s, a), file: path });
  }
  results.sort((a, b) => a.file.localeCompare(b.file));
  const watchPath = join(c.root, 'data/watch/state.json');
  const watch: WatchState | null = existsSync(watchPath) ? JSON.parse(readFileSync(watchPath, 'utf8')) : null;
  const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
  const assessments = c.assessments
    .map(({ path, value }) => ({ file: path, ...value }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const byFile = new Map(assessments.map((a) => [a.file, a]));
  const summaries: Summary[] = results.map((r) => {
    const a = byFile.get(r.file)!;
    return {
      benchmark: r.benchmark, standard: r.standard, file: r.file, status: a.status, kind: a.provenance.kind,
      model: a.model_run?.model ?? null, label: r.overall.label, pct: r.overall.pct, discrepancies: r.discrepancies.length,
    };
  });
  const allStandards = byId(c.standards.map((s) => s.value));
  const pricing: Pricing = PricingSchema.parse(parse(readFileSync(join(c.root, 'config/pricing.yaml'), 'utf8')));
  const plain = byId(c.benchmarks.map((b) => b.value)) as Benchmark[];
  const encodedStds = c.standards.map((s) => s.value).filter((s) => s.status === 'encoded' && s.scoring);
  const parts = plain.map((b) => {
    const r = rigor(rigorInputs(encodedStds, assessments.filter((a) => a.benchmark === b.id)));
    const run = runProfile(b.resources, pricing);
    return { r, run, tokens: run && b.resources?.interaction !== 'non-llm' ? run.tokens : null };
  });
  const onFront = frontier(plain.map((b, i) => ({ id: b.id, score: parts[i]!.r.score, tokens: parts[i]!.tokens })));
  const benchmarks = plain.map((b, i) => ({ ...b, touchstone: { rigor: parts[i]!.r, run: parts[i]!.run, onFrontier: onFront.has(b.id) } }));
  return {
    index: {
      repo: REPO_URL,
      watch,
      pricing,
      standards: allStandards.map(({ groups: _groups, ...meta }): IndexStandard => meta),
      benchmarks,
      summaries,
    },
    benchmarks: benchmarks.map((b): BenchmarkFile => ({
      id: b.id,
      touchstone: b.touchstone,
      assessments: assessments.filter((a) => a.benchmark === b.id),
      results: results.filter((r) => r.benchmark === b.id),
    })),
    standards: allStandards,
  };
}
export type SiteIndex = ReturnType<typeof buildSiteData>['index'];

/** Write index.json, benchmarks/<id>.json and standards/<id>.json under `out`; stale files are removed first. */
export function writeSiteData(c: Corpus, out: string): number {
  const d = buildSiteData(c);
  for (const p of ['index.json', 'benchmarks', 'standards']) rmSync(join(out, p), { recursive: true, force: true });
  const files: [string, unknown][] = [
    ['index.json', d.index],
    ...d.benchmarks.map((b): [string, unknown] => [`benchmarks/${b.id}.json`, b]),
    ...d.standards.map((s): [string, unknown] => [`standards/${s.id}.json`, s]),
  ];
  for (const [path, value] of files) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), JSON.stringify(value) + '\n');
  }
  return files.length;
}
