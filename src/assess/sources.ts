/**
 * Fetch a benchmark's sources at immutable references: a specific arXiv version and a specific git
 * commit. Everything the model sees comes from here, and each source's sha256 is recorded so a
 * later re-fetch can be checked against what the model was given.
 */
import type { Benchmark, SourceSnapshot } from '../schema.ts';
import { chunk, sha256, type Chunk } from './text.ts';

export interface FetchedSource { snapshot: SourceSnapshot; chunks: Chunk[] }
export type Fetch = typeof fetch;

const UA = { 'User-Agent': 'touchstone (+https://github.com/pact-safety/touchstone)' };

export const arxivId = (url: string) => url.match(/arxiv\.org\/abs\/([0-9]{4}\.[0-9]{4,5})/)?.[1];
export const githubRepo = (url: string) => url.match(/github\.com\/([^/]+\/[^/#?]+)/)?.[1]?.replace(/\.git$/, '');

/** Latest arXiv version, e.g. "v3", from the export API. */
export async function arxivLatestVersion(id: string, f: Fetch = fetch): Promise<string> {
  const res = await f(`https://export.arxiv.org/api/query?id_list=${id}`, { headers: UA });
  if (!res.ok) throw new Error(`arXiv API ${res.status} for ${id}`);
  const xml = await res.text();
  const v = xml.match(new RegExp(`arxiv.org/abs/${id.replace('.', '\\.')}(v\\d+)`))?.[1];
  if (!v) throw new Error(`arXiv API returned no version for ${id}`);
  return v;
}

export interface RepoHead { commit: string; archived: boolean; default_branch: string }

export async function githubHead(repo: string, token: string | undefined, f: Fetch = fetch): Promise<RepoHead> {
  const headers: Record<string, string> = { ...UA, Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const meta = await f(`https://api.github.com/repos/${repo}`, { headers });
  if (!meta.ok) throw new Error(`GitHub API ${meta.status} for ${repo}`);
  const m = (await meta.json()) as { default_branch: string; archived: boolean };
  const br = await f(`https://api.github.com/repos/${repo}/commits/${m.default_branch}`, { headers });
  if (!br.ok) throw new Error(`GitHub API ${br.status} for ${repo}@${m.default_branch}`);
  const c = (await br.json()) as { sha: string };
  return { commit: c.sha, archived: m.archived, default_branch: m.default_branch };
}

/** Paper text from the versioned PDF, extracted with the pinned pdfjs-dist. */
export async function fetchPaper(id: string, version: string, f: Fetch = fetch): Promise<FetchedSource> {
  const url = `https://arxiv.org/pdf/${id}${version}`;
  const res = await f(url, { headers: UA });
  if (!res.ok) throw new Error(`arXiv PDF ${res.status} for ${id}${version}`);
  const data = new Uint8Array(await res.arrayBuffer());
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data, useSystemFonts: false, isEvalSupported: false }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    let text = '';
    for (const it of content.items as { str?: string; hasEOL?: boolean }[]) text += (it.str ?? '') + (it.hasEOL ? '\n' : ' ');
    pages.push(text);
  }
  const chunks = pages.flatMap((t, i) => chunk(`paper:p${i + 1}`, `${id}${version} page ${i + 1}`, t));
  const all = pages.join('\n\n');
  return {
    snapshot: { kind: 'paper', url: `https://arxiv.org/abs/${id}${version}`, ref: version, sha256: sha256(all), chars: all.length },
    chunks,
  };
}

/** Files read from a repo, in this order, up to the size budget. Documentation first, then config. */
const REPO_FILES = [/^readme(\.\w+)?$/i, /^docs\/.+\.(md|rst|txt)$/i, /^(requirements[^/]*\.txt|pyproject\.toml|setup\.py|environment\.ya?ml|package\.json|Dockerfile|LICENSE(\.\w+)?)$/i, /^[^/]+\.(md|rst)$/i];

export async function fetchRepo(repo: string, commit: string, token: string | undefined, f: Fetch = fetch, budget = 120_000): Promise<FetchedSource> {
  const headers: Record<string, string> = { ...UA, Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const tree = await f(`https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`, { headers });
  if (!tree.ok) throw new Error(`GitHub tree ${tree.status} for ${repo}@${commit}`);
  const t = (await tree.json()) as { tree: { path: string; type: string; size?: number }[] };
  const blobs = t.tree.filter((x) => x.type === 'blob').map((x) => x.path).sort();
  const picked: string[] = [];
  for (const re of REPO_FILES) for (const p of blobs) if (re.test(p) && !picked.includes(p)) picked.push(p);
  // The file listing itself is evidence (tests, lockfiles, CI, oracle solvers), so it is a source too.
  const listing = blobs.join('\n');
  const parts: { path: string; text: string }[] = [{ path: 'FILE LISTING', text: listing.slice(0, 20_000) }];
  let used = parts[0]!.text.length;
  for (const path of picked) {
    if (used >= budget) break;
    const raw = await f(`https://raw.githubusercontent.com/${repo}/${commit}/${path}`, { headers: UA });
    if (!raw.ok) continue;
    const text = (await raw.text()).slice(0, budget - used);
    parts.push({ path, text });
    used += text.length;
  }
  const chunks = parts.flatMap((p) => chunk(`repo:${p.path}`, `${repo}@${commit.slice(0, 12)}:${p.path}`, p.text));
  const all = parts.map((p) => `== ${p.path}\n${p.text}`).join('\n\n');
  return {
    snapshot: { kind: 'repo', url: `https://github.com/${repo}/tree/${commit}`, ref: commit, sha256: sha256(all), chars: all.length },
    chunks,
  };
}

export interface Pins { paper_version?: string; repo_commit?: string; archived?: boolean }

export async function currentPins(b: Benchmark, token: string | undefined, f: Fetch = fetch): Promise<Pins> {
  const pins: Pins = {};
  const id = b.links.paper ? arxivId(b.links.paper) : undefined;
  if (id) pins.paper_version = await arxivLatestVersion(id, f);
  const repo = b.links.repo ? githubRepo(b.links.repo) : undefined;
  if (repo) {
    const head = await githubHead(repo, token, f);
    pins.repo_commit = head.commit;
    pins.archived = head.archived;
  }
  return pins;
}

export async function fetchSources(b: Benchmark, pins: Pins, token: string | undefined, f: Fetch = fetch): Promise<FetchedSource[]> {
  const out: FetchedSource[] = [];
  const id = b.links.paper ? arxivId(b.links.paper) : undefined;
  if (id && pins.paper_version) out.push(await fetchPaper(id, pins.paper_version, f));
  const repo = b.links.repo ? githubRepo(b.links.repo) : undefined;
  if (repo && pins.repo_commit) out.push(await fetchRepo(repo, pins.repo_commit, token, f));
  return out;
}
