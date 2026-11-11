/**
 * Turn the reviewer's "other" notes into verdicts for apply-review.ts --note-verdicts.
 *   npx tsx scripts/notes-to-verdicts.ts --decisions <file> --rows <rows.json> --out <file>
 * Writes { "<pair>": { "<item>": Verdict } } for "other" rows whose note starts with a value
 * (Met, Unmet, N/A, a number, or "Score <n>"); prints the rows it could not convert, with the reason.
 * The note's URLs become evidence if immutable (GitHub URLs are pinned to the repo's current HEAD commit via `gh`).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readDocs } from './apply-review.ts';
import type { Rows } from './crosscheck.ts';
import { load } from '../src/load.ts';

type Evidence = { source: string; url: string; locator: string };
export type NoteVerdict = { value: string | number; rationale?: string; evidence: Evidence[]; by: 'human' };
/** Resolves "owner/repo" to a 40-character commit SHA, or undefined when it can't. */
export type Pin = (repo: string) => string | undefined;

const VALUE = /^\s*(?:(Unmet|Met|N\/A|NA)(?![A-Za-z/])|(?:Score\s+)?(\d+)(?![\d.]*\d|[A-Za-z]))[\s:—–-]*/i;
const LOCATOR = /§+\s*[\w.]+(?:\/[\w.]+)?|Appendix\s+[A-Z0-9][\w.]*|(?:Sections?|Tables?|Figures?|[Pp]ages?)\s+\d[\w.]*/;
const GITHUB = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/(blob|tree)\/([^/\s]+)(\/\S*)?)?\/?$/;

function toEvidence(url: string, pin: Pin): Evidence | undefined {
  const arx = url.match(/^https?:\/\/arxiv\.org\/(?:html|abs|pdf)\/(\d{4}\.\d{4,5}v\d+)/);
  if (arx) return { source: 'paper', url: `https://arxiv.org/abs/${arx[1]}`, locator: '' };
  const gh = url.match(GITHUB);
  if (gh) {
    const [, owner, repo, kind, ref, path = ''] = gh;
    if (kind && /^[0-9a-f]{40}$/i.test(ref!)) return { source: 'repo', url, locator: '' };
    const sha = pin(`${owner}/${repo}`);
    return !sha ? undefined : { source: 'repo', url: `https://github.com/${owner}/${repo}/${kind ?? 'tree'}/${sha}${path}`, locator: '' };
  }
  return /^https?:\/\/web\.archive\.org\/web\/\d+\//.test(url) ? { source: 'website', url, locator: '' } : undefined;
}

/** GitHub repos named in a note, for pre-resolving their HEADs. */
export const githubRepos = (note: string): string[] =>
  (note.match(/https?:\/\/\S+/g) ?? []).map((u) => u.replace(/[.,;)]+$/, '').match(GITHUB)).filter(Boolean).map((m) => `${m![1]}/${m![2]}`);

/** The note after its value token: URLs and their "Sources:"/"Rubric:" labels removed, leading separators stripped, first letter capitalised. */
export function cleanRationale(text: string): string {
  let t = text.replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ');
  t = t.replace(/\b(?:Sources?|Rubric|See):\s*(?=(?:and\b\s*)?(?:[,;.]|$))/gi, ' ');
  for (let prev = ''; prev !== t;) { prev = t; t = t.replace(/\s*\b(?:and|or)\s*[,;.]?\s*$/i, '').replace(/[\s,;]+$/, ''); }
  t = t.replace(/\s+([,;.)])/g, '$1').replace(/([,;])\s*[,;]/g, '$1').replace(/^[\s.:,;—–-]+/, '').replace(/\s+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Same arXiv paper (any version) or same page, ignoring a trailing slash and fragment. */
const arxivId = (u: string) => u.match(/arxiv\.org\/(?:html|abs|pdf)\/(\d{4}\.\d{4,5})/)?.[1];
const sameSource = (a: string, b: string) => (arxivId(a) && arxivId(a) === arxivId(b)) || a.replace(/[#?].*$/, '').replace(/\/$/, '') === b.replace(/[#?].*$/, '').replace(/\/$/, '');

/** Pure: one note to a verdict, or the reason it can't be one. */
export function noteToVerdict(note: string | undefined, pin: Pin, canBeNA = true, standardUrls: string[] = []): { verdict: NoteVerdict } | { reason: string } {
  if (!note?.trim()) return { reason: 'no note' };
  const m = note.match(VALUE);
  if (!m) return { reason: 'no clear value' };
  const value: string | number = m[1] ? ({ unmet: 'unmet', met: 'met' } as Record<string, string>)[m[1].toLowerCase()] ?? 'n/a' : Number(m[2]);
  if (value === 'n/a' && !canBeNA) return { reason: 'n/a on an item with no n/a condition' };
  const urls = (note.match(/https?:\/\/\S+/g) ?? []).map((u) => u.replace(/[.,;)]+$/, '')).filter((u) => !standardUrls.some((s) => sameSource(u, s))); // the standard's own paper is the rubric, not evidence
  const locator = note.replace(/https?:\/\/\S+/g, ' ').match(LOCATOR)?.[0].replace(/[.,;)]+$/, '') ?? 'reviewer note';
  const evidence = urls.flatMap((u) => { const e = toEvidence(u, pin); return e ? [{ ...e, locator }] : []; });
  const rationale = cleanRationale(note.slice(m[0].length));
  const positive = value === 'met' || (typeof value === 'number' && value > 0);
  if (positive && !evidence.length) return { reason: 'positive verdict without fixed-version evidence' };
  if (!positive && !rationale && !evidence.length) return { reason: 'no rationale or evidence' };
  return { verdict: { value, ...(rationale ? { rationale } : {}), evidence, by: 'human' } };
}

const ghHead = (repo: string): string | undefined => {
  try { return execFileSync('gh', ['api', `repos/${repo}/commits/HEAD`, '--jq', '.sha'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; } catch { return undefined; }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values } = parseArgs({ options: { decisions: { type: 'string' }, rows: { type: 'string' }, out: { type: 'string' }, 'standard-source': { type: 'string', multiple: true } } });
  if (!values.decisions || !values.rows || !values.out) { console.error('usage: notes-to-verdicts.ts --decisions <file> --rows <rows.json> --out <file> [--standard-source <standard>=<url>]...'); process.exit(1); }
  const rows: Rows = JSON.parse(readFileSync(values.rows, 'utf8'));
  const known = new Set(rows.rows.map((r) => r.key));
  const todo = readDocs(readFileSync(values.decisions, 'utf8')).flatMap((d) =>
    Object.entries(d.data.choices ?? {}).filter(([item, c]) => c === 'other' && known.has(`${d.id}~${item}`)).map(([item]) => ({ pair: d.id, item, note: d.data.notes?.[item] as string | undefined })));
  const corpus = load(new URL('..', import.meta.url).pathname);
  // A standard's own page or paper (its url and archived_url, plus any --standard-source id=url) is the rubric, not evidence.
  const own = new Map<string, string[]>(corpus.standards.map(({ value: st }) => [st.id, [st.url, ...(st.archived_url ? [st.archived_url] : [])]]));
  for (const x of values['standard-source'] ?? []) { const [id, url] = x.split(/=(.*)/s); own.set(id!, [...(own.get(id!) ?? []), url!]); }
  const naItems = new Set(corpus.standards.flatMap(({ value: st }) => st.groups.flatMap((g) => g.items.filter((i) => i.guidance?.not_applicable).map((i) => `${st.id}~${i.id}`))));
  const standardOf = new Map(rows.pairs.map((p) => [p.id, p.standard]));
  const cache = new Map<string, string | undefined>();
  for (const t of todo) for (const r of githubRepos(t.note ?? '')) if (!cache.has(r)) cache.set(r, ghHead(r));
  const out: Record<string, Record<string, NoteVerdict>> = {};
  const unconverted: string[] = [];
  const counts: Record<string, number> = {};
  for (const t of todo) {
    const r = noteToVerdict(t.note, (repo) => cache.get(repo), naItems.has(`${standardOf.get(t.pair)}~${t.item}`), own.get(standardOf.get(t.pair)!) ?? []);
    if ('verdict' in r) (out[t.pair] ??= {})[t.item] = r.verdict;
    else { counts[r.reason] = (counts[r.reason] ?? 0) + 1; unconverted.push(`${t.pair}~${t.item}: ${r.reason}`); }
  }
  writeFileSync(values.out, JSON.stringify(out, null, 2) + '\n');
  console.log(`converted ${todo.length - unconverted.length} of ${todo.length} other rows; not converted ${unconverted.length}: ${JSON.stringify(counts)}`);
  for (const u of unconverted) console.log(`NOT CONVERTED ${u}`);
}
