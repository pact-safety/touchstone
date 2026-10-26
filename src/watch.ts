/**
 * The nightly check: what is each benchmark's current paper version and repo commit, and which
 * (benchmark, standard) pairs need a fresh automated assessment because they are new, their
 * sources changed, or the standard was revised.
 */
import type { Corpus } from './load.ts';
import type { Benchmark, Standard } from './schema.ts';
import { currentPins, type Fetch, type Pins } from './assess/sources.ts';

export interface WatchState {
  checked_on: string;
  benchmarks: Record<string, Pins & { error?: string }>;
}

export interface QueueEntry { benchmark: string; standard: string; reason: 'new' | 'sources-changed' | 'standard-revised' }

export const inScope = (s: Standard, b: Benchmark) =>
  s.status === 'encoded' &&
  (!s.scope?.modalities || s.scope.modalities.includes(b.modality)) &&
  (!s.scope?.domains || s.scope.domains.includes(b.domain));

export async function check(c: Corpus, today: string, token: string | undefined, f: Fetch = fetch): Promise<WatchState> {
  const state: WatchState = { checked_on: today, benchmarks: {} };
  for (const { value: b } of [...c.benchmarks].sort((x, y) => x.value.id.localeCompare(y.value.id))) {
    try {
      state.benchmarks[b.id] = await currentPins(b, token, f);
    } catch (e) {
      state.benchmarks[b.id] = { error: (e as Error).message };
    }
  }
  return state;
}

/** Deterministic work queue: changed sources first, then revised standards, then never-assessed pairs; each by id. */
export function queue(c: Corpus, state: WatchState): QueueEntry[] {
  const out: QueueEntry[] = [];
  const autos = new Map(c.assessments.filter((a) => a.value.provenance.kind === 'automated').map((a) => [`${a.value.benchmark}/${a.value.standard}`, a.value]));
  for (const { value: b } of c.benchmarks) {
    const pins = state.benchmarks[b.id];
    if (!pins || pins.error || (!pins.paper_version && !pins.repo_commit)) continue;
    for (const { value: s } of c.standards) {
      if (!inScope(s, b)) continue;
      const prev = autos.get(`${b.id}/${s.id}`);
      if (!prev) { out.push({ benchmark: b.id, standard: s.id, reason: 'new' }); continue; }
      const ref = prev.benchmark_ref ?? {};
      if (ref.paper_version !== pins.paper_version || ref.repo_commit !== pins.repo_commit) out.push({ benchmark: b.id, standard: s.id, reason: 'sources-changed' });
      else if (prev.standard_version !== s.version) out.push({ benchmark: b.id, standard: s.id, reason: 'standard-revised' });
    }
  }
  const order = { 'sources-changed': 0, 'standard-revised': 1, new: 2 } as const;
  return out.sort((a, b) => order[a.reason] - order[b.reason] || a.benchmark.localeCompare(b.benchmark) || a.standard.localeCompare(b.standard));
}
