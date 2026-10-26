/**
 * The Touchstone score: two separate parts, never blended into one number.
 *   1. Rigor consensus: the median of the benchmark's published ratings, each normalized to 0-100.
 *   2. Run cost: what a full run needs, from the benchmark's `resources` record.
 * Plus a value frontier over the two. Every function is pure; see docs/touchstone-score.md.
 */
import { round1, score, type Result } from './engine.ts';
import type { Assessment, Resources, Standard } from './schema.ts';

export type Grade = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export type Provenance = Assessment['provenance']['kind'];

export interface RigorInput {
  /** Standard id. */
  standard: string;
  /** Short name of the standard, for sentences. */
  short: string;
  /** The standard's own verdict, e.g. "Category C" or "61.2%". */
  label: string;
  /** 0-100, or null when the result is incomplete. */
  normalized: number | null;
  provenance: Provenance;
}
export interface Rigor {
  score: number | null;
  grade: Grade | null;
  n: number;
  spread: number | null;
  agreement: 'single' | 'high' | 'moderate' | 'low' | null;
  confidence: 'high' | 'medium' | 'low';
  gradeStable: boolean;
  inputs: RigorInput[];
  explanation: string;
}
export interface Pricing { as_of: string; low_usd_per_mtok: number; high_usd_per_mtok: number }
export interface RunProfile {
  tokens: number;
  apiTier: 'none' | '$' | '$$' | '$$$' | '$$$$' | '$$$$$';
  costUsd: [number, number];
  localTier: 'Lite' | 'Standard' | 'Heavy' | 'Extreme';
  explanation: string;
}
export interface TouchstoneData { rigor: Rigor; run: RunProfile | null; onFrontier: boolean }

const CATEGORY_POINTS: Record<string, number> = { A: 100, B: 80, C: 60, D: 40, E: 20 };

/** A standard's overall result on a 0-100 scale, or null when it has no overall number. */
export function normalize(standard: Standard, result: Result): number | null {
  const { label, pct } = result.overall;
  if (label === 'Incomplete') return null;
  if (standard.scoring?.scheme === 'aisl-severity') {
    if (label === 'Unclassified') return 0;
    return CATEGORY_POINTS[/^Category ([A-E])$/.exec(label)?.[1] ?? ''] ?? null;
  }
  return pct;
}

const KIND_RANK: Record<Provenance, number> = { touchstone: 0, external: 1, automated: 2 };

/** One input per encoded standard: published assessments only, preferring touchstone, then external, then automated. */
export function rigorInputs(standards: Standard[], assessments: Assessment[]): RigorInput[] {
  const out: RigorInput[] = [];
  for (const s of standards) {
    if (s.status !== 'encoded') continue;
    const a = assessments
      .filter((x) => x.standard === s.id && x.status === 'published')
      .sort((x, y) => KIND_RANK[x.provenance.kind] - KIND_RANK[y.provenance.kind] || y.provenance.assessed_on.localeCompare(x.provenance.assessed_on))[0];
    if (!a) continue;
    const r = score(s, a);
    out.push({ standard: s.id, short: s.short, label: r.overall.label, normalized: normalize(s, r), provenance: a.provenance.kind });
  }
  return out.sort((x, y) => x.standard.localeCompare(y.standard));
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const CUTS: [number, Grade][] = [[85, 'A'], [70, 'B'], [55, 'C'], [40, 'D'], [25, 'E']];
const gradeOf = (x: number, shift = 0): Grade => CUTS.find(([c]) => x >= c + shift)?.[1] ?? 'F';

export function rigor(inputs: RigorInput[]): Rigor {
  const vals = inputs.map((i) => i.normalized).filter((x): x is number => x !== null);
  const n = vals.length;
  if (!n)
    return { score: null, grade: null, n, spread: null, agreement: null, confidence: 'low', gradeStable: false, inputs,
      explanation: 'No published assessment under an encoded standard yields a score, so there is no rigor score.' };
  const sc = round1(median(vals));
  const grade = gradeOf(sc);
  const spread = round1(Math.max(...vals) - Math.min(...vals));
  const agreement = n === 1 ? 'single' : spread <= 15 ? 'high' : spread <= 30 ? 'moderate' : 'low';
  const confidence = n >= 3 && agreement !== 'low' ? 'high' : (n === 2 && agreement !== 'low') || (n >= 3 && agreement === 'low') ? 'medium' : 'low';
  const gradeStable = gradeOf(sc, -5) === grade && gradeOf(sc, 5) === grade;
  const shown = inputs.filter((i) => i.normalized !== null).map((i) => `${i.short} ${round1(i.normalized!)}`).join(', ');
  const skipped = inputs.length - n;
  const explanation = (n === 1
    ? `One standard (${shown}) = ${sc} → ${grade}. With a single standard agreement cannot be checked; confidence ${confidence}.`
    : `Median of ${n} standards (${shown}) = ${sc} → ${grade}. Spread ${spread} → ${agreement} agreement; confidence ${confidence}.`)
    + (skipped ? ` ${skipped} incomplete ${skipped === 1 ? 'rating is' : 'ratings are'} left out.` : '');
  return { score: sc, grade, n, spread, agreement, confidence, gradeStable, inputs, explanation };
}

const TIERS: RunProfile['apiTier'][] = ['$', '$$', '$$$', '$$$$', '$$$$$'];
const sig2 = (x: number) => Number(x.toPrecision(2));
const fmt = (n: number) => n.toLocaleString('en-US');

/** Run cost from a benchmark's resources record, or null when it has none. */
export function runProfile(r: Resources | null | undefined, pricing: Pricing): RunProfile | null {
  if (!r) return null;
  const llm = r.interaction !== 'non-llm';
  const tokens = Math.round(r.items * (r.model_calls_per_item + r.judge_calls_per_item) * r.tokens_per_call);
  const apiTier = llm ? TIERS[Math.min(4, [1e6, 1e7, 1e8, 1e9].filter((t) => tokens >= t).length)]! : 'none';
  const costUsd: [number, number] = llm
    ? [sig2((tokens / 1e6) * pricing.low_usd_per_mtok), sig2((tokens / 1e6) * pricing.high_usd_per_mtok)]
    : [0, 0];
  const [localTier, why]: [RunProfile['localTier'], string] =
    r.disk_gb > 500 ? ['Extreme', `it needs ${fmt(r.disk_gb)} GB of disk`]
    : r.environment === 'vm' && r.items > 500 ? ['Extreme', `it runs ${fmt(r.items)} items in virtual machines`]
    : r.gpu_required ? ['Heavy', 'the harness needs a GPU']
    : r.environment === 'vm' ? ['Heavy', 'it runs in virtual machines']
    : r.disk_gb > 50 ? ['Heavy', `it needs ${fmt(r.disk_gb)} GB of disk`]
    : ['docker', 'simulator', 'live-web'].includes(r.environment) ? ['Standard', `it needs a ${r.environment} environment`]
    : r.disk_gb > 5 ? ['Standard', `it needs ${fmt(r.disk_gb)} GB of disk`]
    : r.interaction === 'agentic' ? ['Standard', 'the model acts in an environment (agentic)']
    : ['Lite', 'it needs no special environment, GPU or large download'];
  const explanation = llm
    ? `About ${fmt(tokens)} tokens per full run (items × model and judge calls × tokens per call), an estimate. API tier ${apiTier}. Local tier ${localTier} because ${why}; this covers the harness only, not hosting the model under test.`
    : `This benchmark does not call a language model, so it has no token cost. Local tier ${localTier} because ${why}; this covers the harness only, not hosting the model under test.`;
  return { tokens, apiTier, costUsd, localTier, explanation };
}

/** Ids of benchmarks no other benchmark beats: no row has score ≥ and tokens ≤ with one strictly better. Rows without a score or tokens (including non-llm) are excluded. */
export function frontier(rows: { id: string; score: number | null; tokens: number | null }[]): Set<string> {
  const ok = rows.filter((r): r is { id: string; score: number; tokens: number } => r.score !== null && r.tokens !== null);
  return new Set(ok.filter((r) => !ok.some((o) => o.score >= r.score && o.tokens <= r.tokens && (o.score > r.score || o.tokens < r.tokens))).map((r) => r.id));
}
