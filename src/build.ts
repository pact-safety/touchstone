/**
 * Build the site's data file. Output depends only on the repository contents (no clock), so the
 * same commit always produces byte-identical JSON.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Corpus } from './load.ts';
import { score, type Result } from './engine.ts';
import type { WatchState } from './watch.ts';

export const REPO_URL = 'https://github.com/pact-safety/touchstone';

export function buildSiteData(c: Corpus) {
  const standards = new Map(c.standards.map((s) => [s.value.id, s.value]));
  const results: (Result & { file: string })[] = [];
  for (const { path, value: a } of c.assessments) {
    const s = standards.get(a.standard);
    if (!s || s.status !== 'encoded') continue;
    results.push({ ...score(s, a), file: path });
  }
  const watchPath = join(c.root, 'data/watch/state.json');
  const watch: WatchState | null = existsSync(watchPath) ? JSON.parse(readFileSync(watchPath, 'utf8')) : null;
  const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
  return {
    repo: REPO_URL,
    watch,
    standards: byId(c.standards.map((s) => s.value)),
    benchmarks: byId(c.benchmarks.map((b) => b.value)),
    assessments: c.assessments
      .map(({ path, value }) => ({ file: path, ...value }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    results: results.sort((a, b) => a.file.localeCompare(b.file)),
  };
}
export type SiteData = ReturnType<typeof buildSiteData>;
