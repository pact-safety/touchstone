/**
 * Deterministic text handling for the assessor: normalisation, chunking, retrieval and quote
 * verification. Given the same source text, every function here returns the same output.
 */
import { createHash } from 'node:crypto';

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Normalise text for quote matching: Unicode NFKC, rejoin words hyphenated across line breaks,
 * straighten quotes and dashes, collapse whitespace, lowercase. A quote is verified when its
 * normalised form is a substring of the normalised source chunk.
 */
export function normalize(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/(\w)-\s*\n\s*(\w)/g, '$1$2')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface Chunk {
  /** Stable id: `<source kind>:<path or "paper">#<index>`. */
  id: string;
  source: string;
  locator: string;
  text: string;
}

/** Split into ~`size`-character chunks on paragraph, then sentence, boundaries. */
export function chunk(sourceId: string, locator: string, text: string, size = 1200): Chunk[] {
  const paras = text.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const p of paras) {
    if (p.length <= size) { pieces.push(p); continue; }
    let cur = '';
    for (const sent of p.split(/(?<=[.!?])\s+/)) {
      if (cur && cur.length + sent.length + 1 > size) { pieces.push(cur); cur = ''; }
      cur = cur ? `${cur} ${sent}` : sent;
      while (cur.length > size * 1.5) { pieces.push(cur.slice(0, size)); cur = cur.slice(size); }
    }
    if (cur) pieces.push(cur);
  }
  const out: Chunk[] = [];
  let cur = '';
  const flush = () => {
    if (!cur) return;
    out.push({ id: `${sourceId}#${out.length}`, source: sourceId, locator: `${locator}, chunk ${out.length}`, text: cur });
    cur = '';
  };
  for (const p of pieces) {
    if (cur && cur.length + p.length + 2 > size) flush();
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  flush();
  return out;
}

const STOP = new Set('a an the and or of to in on for with by is are be as at that this it its from was were not no can each any all which their there should must when where how what than then into over under per we our they them'.split(' '));
const terms = (s: string) => normalize(s).split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));

/** BM25 (k1 = 1.2, b = 0.75). Ties break by chunk order, so the ranking is fully deterministic. */
export function rank(chunks: Chunk[], query: string, k: number): Chunk[] {
  const docs = chunks.map((c) => terms(c.text));
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(terms(query))];
  const N = docs.length;
  const scored = docs.map((d, i) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const n = df.get(t)!;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.length / avg))));
    }
    return { i, s };
  });
  return scored
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, k)
    .sort((a, b) => a.i - b.i)
    .map((x) => chunks[x.i]!);
}

/** True when the quote, normalised, appears in the chunk, normalised. Quotes under 12 characters never verify. */
export function verifyQuote(quote: string, chunkText: string): boolean {
  const q = normalize(quote);
  return q.length >= 12 && normalize(chunkText).includes(q);
}
