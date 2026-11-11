// Benchmark x standard coverage categories. Pure (no DOM) so tests/coverage.test.ts can run it in node.
export type Cat = 'reviewed' | 'draft' | 'pending' | 'na' | 'blocked';
export const CATS: Cat[] = ['reviewed', 'draft', 'pending', 'na', 'blocked'];
interface Std { id: string; status: string; scope?: { modalities?: string[]; domains?: string[] } }
interface Bench { id: string; domain: string; modality: string }
interface Sum { benchmark: string; standard: string; status: string }

export const inScope = (s: Std, b: Bench) =>
  (!s.scope?.modalities || s.scope.modalities.includes(b.modality)) && (!s.scope?.domains || s.scope.domains.includes(b.domain));

/** One category per pair. A published summary beats a draft; a standard we can't encode is blocked whatever the data says. */
export function categorize(s: Std, b: Bench, sums: Sum[]): Cat {
  if (s.status !== 'encoded') return 'blocked';
  const mine = sums.filter((a) => a.benchmark === b.id && a.standard === s.id);
  if (mine.some((a) => a.status === 'published')) return 'reviewed';
  if (mine.some((a) => a.status === 'draft')) return 'draft';
  return inScope(s, b) ? 'pending' : 'na';
}

export function coverage<B extends Bench>(standards: Std[], benchmarks: B[], summaries: Sum[]) {
  const cols = [...benchmarks].sort((a, b) => a.domain.localeCompare(b.domain) || a.modality.localeCompare(b.modality) || a.id.localeCompare(b.id));
  const cells = standards.map((s) => cols.map((b) => categorize(s, b, summaries)));
  const counts = Object.fromEntries(CATS.map((c) => [c, 0])) as Record<Cat, number>;
  for (const row of cells) for (const c of row) counts[c]++;
  const rateable = counts.reviewed + counts.draft + counts.pending;
  return { cols, cells, counts, rateable, reviewedShare: rateable ? counts.reviewed / rateable : 0 };
}
