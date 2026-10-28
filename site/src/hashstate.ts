// Ratings-view state <-> URL hash query. Pure (no DOM) so tests/hashstate.test.ts can run it in node.
export const MAX_COMPARE = 4;
export interface View { q: string; domain: string; modality: string; source: string; value: string; sort: string; dir: number; compare: string[] }
export const DEFAULT_VIEW: View = { q: '', domain: '', modality: '', source: 'all', value: '', sort: 'touchstone', dir: -1, compare: [] };

/** Columns whose first click sorts ascending (A to Z, cheapest first). */
export const ascFirst = (k: string) => k === 'name' || k === 'domain' || k === 'run';

/** `#/` plus only the parts that differ from the defaults, e.g. `#/?domain=safety&sort=run&compare=a,b`. */
export function encodeView(v: View): string {
  const p = new URLSearchParams();
  if (v.q) p.set('q', v.q);
  if (v.domain) p.set('domain', v.domain);
  if (v.modality) p.set('type', v.modality);
  if (v.source !== DEFAULT_VIEW.source) p.set('source', v.source);
  if (v.value) p.set('value', v.value);
  if (v.sort !== DEFAULT_VIEW.sort) p.set('sort', v.sort);
  if (v.dir !== (v.sort === DEFAULT_VIEW.sort ? DEFAULT_VIEW.dir : ascFirst(v.sort) ? 1 : -1)) p.set('dir', v.dir > 0 ? 'asc' : 'desc');
  if (v.compare.length) p.set('compare', v.compare.join(','));
  const qs = p.toString().replace(/%2C/g, ',');
  return qs ? `#/?${qs}` : '#/';
}

/** Parse a hash query; unknown or invalid values fall back to the defaults (the URL is untrusted input). */
export function decodeView(qs: string, ok: { sorts: string[]; modalities: string[]; benchmarks: Set<string> }): View {
  const p = new URLSearchParams(qs);
  const pick = (k: string, allowed: string[], d: string) => (allowed.includes(p.get(k) ?? '') ? p.get(k)! : d);
  const sort = pick('sort', ok.sorts, DEFAULT_VIEW.sort);
  const dirParam = p.get('dir');
  return {
    q: (p.get('q') ?? '').slice(0, 100),
    domain: pick('domain', ['safety', 'capability'], ''),
    modality: pick('type', ok.modalities, ''),
    source: pick('source', ['all', 'published', 'automated'], 'all'),
    value: pick('value', ['best'], ''),
    sort,
    dir: dirParam === 'asc' ? 1 : dirParam === 'desc' ? -1 : ascFirst(sort) ? 1 : -1,
    compare: [...new Set((p.get('compare') ?? '').split(',').filter((id) => ok.benchmarks.has(id)))].slice(0, MAX_COMPARE),
  };
}
