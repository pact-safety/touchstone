/**
 * The scoring engine. Every function here is pure: the same standard and assessment always
 * give the same result, with no clock, randomness, network or file access. Assessors decide
 * item verdicts; everything after that is arithmetic defined in this file and docs/methodology.md.
 * Each result carries a plain-language explanation of how its number follows from the verdicts.
 */
import type { Assessment, Group, Standard, Verdict } from './schema.ts';

export type GroupState = 'scored' | 'invalid' | 'unscored';

export interface GroupResult {
  id: string;
  name: string;
  state: GroupState;
  /** Native score: 1–4 for AISL (1 best), mean level for points, percent for checklists. */
  score: number | null;
  display: string;
  /** Position on the standard's own scale, 0–100 (100 best). For bar length only; not comparable across standards. */
  pct: number | null;
  counts: { met: number; unmet: number; na: number; missing: number };
  /** AISL: unmet highlighted items that set the score. */
  capped_by: string[];
  /** AISL: unmet baseline items that invalidated the dimension. */
  failed_baseline: string[];
  /** How the score follows from the verdicts, in plain words. */
  explanation: string;
}

export interface Discrepancy {
  field: string;
  published: string;
  computed: string;
}

export interface Result {
  benchmark: string;
  standard: string;
  mode: Assessment['mode'];
  groups: GroupResult[];
  overall: { score: number | null; display: string; pct: number | null; label: string; explanation: string };
  discrepancies: Discrepancy[];
  completeness: { assessed: number; total: number };
}

/** Round half up to one decimal. Applied only for display and comparison, never mid-calculation. */
export const round1 = (x: number): number => Math.round((x + Number.EPSILON) * 10) / 10;

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const emptyCounts = () => ({ met: 0, unmet: 0, na: 0, missing: 0 });
const list = (ids: string[]) => ids.join(', ');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Verdict for an item. A missing verdict counts as unmet: undocumented means unsatisfied. */
function verdictOf(a: Assessment, itemId: string): Verdict['value'] | 'missing' {
  const v = a.verdicts?.[itemId];
  return v ? v.value : 'missing';
}

export function score(standard: Standard, a: Assessment): Result {
  if (!standard.scoring) throw new Error(`${standard.id} has no scoring rule`);
  const s = standard.scoring;
  const total = standard.groups.reduce((n, g) => n + g.items.length, 0);
  const assessed = a.mode === 'itemized' ? standard.groups.flatMap((g) => g.items).filter((i) => a.verdicts?.[i.id]).length : 0;

  let groups: GroupResult[];
  if (a.mode === 'imported') groups = standard.groups.map((g) => importedGroup(standard, g, a.scores?.[g.id]));
  else if (s.scheme === 'aisl-severity') groups = standard.groups.map((g) => aislGroup(g, a, s.severity_scores));
  else if (s.scheme === 'points') groups = standard.groups.map((g) => pointsGroup(g, a, s.max));
  else groups = standard.groups.map((g) => checklistGroup(g, a));

  const overall = overallOf(standard, a, groups);
  return {
    benchmark: a.benchmark,
    standard: a.standard,
    mode: a.mode,
    groups,
    overall,
    discrepancies: discrepancies(standard, a, groups, overall),
    completeness: { assessed, total },
  };
}

function aislGroup(g: Group, a: Assessment, sev: { yellow: number; orange: number; red: number }): GroupResult {
  const counts = emptyCounts();
  const capped_by: string[] = [];
  const failed_baseline: string[] = [];
  let worst = 1;
  for (const item of g.items) {
    const v = verdictOf(a, item.id);
    if (v === 'n/a') { counts.na++; continue; }
    if (v === 'met') { counts.met++; continue; }
    if (v === 'missing') counts.missing++;
    else counts.unmet++;
    if (item.severity === 'baseline' || !item.severity) failed_baseline.push(item.id);
    else {
      capped_by.push(item.id);
      worst = Math.max(worst, sev[item.severity]);
    }
  }
  const base = { id: g.id, name: g.name, counts, capped_by, failed_baseline };
  if (failed_baseline.length)
    return {
      ...base, state: 'invalid', score: null, display: 'Invalid', pct: 0,
      explanation: `Invalid: baseline ${failed_baseline.length === 1 ? 'requirement' : 'requirements'} ${list(failed_baseline)} ${failed_baseline.length === 1 ? 'is' : 'are'} not met, so this dimension cannot be scored.`,
    };
  const sevOf = (id: string) => g.items.find((i) => i.id === id)!.severity!;
  const explanation = capped_by.length
    ? `${worst}: unmet ${capped_by.map((id) => `${id} (${sevOf(id)}, caps at ${sev[sevOf(id) as 'yellow']})`).join(', ')}; the worst cap applies.`
    : `1: every applicable item is met (${plural(counts.met, 'item')} met${counts.na ? `, ${counts.na} n/a` : ''}).`;
  return { ...base, state: 'scored', score: worst, display: String(worst), pct: aislPct(worst), explanation };
}

const aislPct = (x: number) => round1(((4 - x) / 3) * 100);

function pointsGroup(g: Group, a: Assessment, max: number): GroupResult {
  const counts = emptyCounts();
  const levels: number[] = [];
  for (const item of g.items) {
    const v = verdictOf(a, item.id);
    if (v === 'n/a') counts.na++;
    else if (v === 'missing') { counts.missing++; levels.push(0); }
    else if (typeof v === 'number') { levels.push(v); if (v > 0) counts.met++; else counts.unmet++; }
    else throw new Error(`${a.benchmark}/${a.standard} ${item.id}: points items take a number or "n/a", got "${v}"`);
  }
  const m = mean(levels);
  const sum = levels.reduce((x, y) => x + y, 0);
  return {
    id: g.id, name: g.name, state: m === null ? 'unscored' : 'scored', score: m,
    display: m === null ? 'n/a' : `${round1(m)}`, pct: m === null ? null : round1((m / max) * 100),
    counts, capped_by: [], failed_baseline: [],
    explanation: m === null
      ? 'No applicable criteria.'
      : `${sum} points over ${plural(levels.length, 'applicable criterion', 'applicable criteria')} = ${round1(m)} of ${max}${counts.na ? ` (${counts.na} n/a excluded)` : ''}${counts.missing ? `; ${counts.missing} without a verdict counted as 0` : ''}.`,
  };
}

function checklistGroup(g: Group, a: Assessment): GroupResult {
  const counts = emptyCounts();
  for (const item of g.items) {
    const v = verdictOf(a, item.id);
    if (v === 'n/a') counts.na++;
    else if (v === 'met') counts.met++;
    else if (v === 'unmet') counts.unmet++;
    else if (v === 'missing') counts.missing++;
    else throw new Error(`${a.benchmark}/${a.standard} ${item.id}: checklist items take met, unmet or n/a, got ${v}`);
  }
  const applicable = counts.met + counts.unmet + counts.missing;
  const pct = applicable ? (counts.met / applicable) * 100 : null;
  return {
    id: g.id, name: g.name, state: pct === null ? 'unscored' : 'scored', score: pct,
    display: pct === null ? 'n/a' : `${round1(pct)}%`, pct: pct === null ? null : round1(pct),
    counts, capped_by: [], failed_baseline: [],
    explanation: pct === null
      ? 'No applicable items.'
      : `${counts.met} of ${plural(applicable, 'applicable item')} met = ${round1(pct)}%${counts.na ? ` (${counts.na} n/a excluded)` : ''}${counts.missing ? `; ${counts.missing} without a verdict counted as unmet` : ''}.`,
  };
}

function importedGroup(standard: Standard, g: Group, v: number | 'invalid' | null | undefined): GroupResult {
  const base = { id: g.id, name: g.name, counts: emptyCounts(), capped_by: [], failed_baseline: [] };
  if (v === 'invalid') return { ...base, state: 'invalid', score: null, display: 'Invalid', pct: 0, explanation: 'Reported as invalid by the source.' };
  if (v === null || v === undefined) return { ...base, state: 'unscored', score: null, display: 'Not reported', pct: null, explanation: 'The source did not report this dimension.' };
  const s = standard.scoring!;
  const explanation = 'Score as published by the source; item-level verdicts were not published.';
  if (s.scheme === 'aisl-severity') return { ...base, state: 'scored', score: v, display: String(v), pct: aislPct(v), explanation };
  if (s.scheme === 'points') return { ...base, state: 'scored', score: v, display: `${round1(v)}`, pct: round1((v / s.max) * 100), explanation };
  return { ...base, state: 'scored', score: v, display: `${round1(v)}%`, pct: round1(v), explanation };
}

function overallOf(standard: Standard, a: Assessment, groups: GroupResult[]): Result['overall'] {
  const s = standard.scoring!;
  if (s.scheme === 'aisl-severity') {
    const cats = s.categories;
    const blocked = groups.filter((g) => g.state !== 'scored');
    const idx = blocked.length ? -1 : cats.findIndex((c) => groups.every((g) => (g.score as number) <= c.max[g.id]!));
    if (idx === -1) {
      const why = blocked.length
        ? `${list(blocked.map((g) => g.name))} ${blocked.length === 1 ? 'has' : 'have'} no score, so no category applies.`
        : 'The dimension scores meet no category\'s limits.';
      return { score: null, display: 'Unclassified', pct: 0, label: 'Unclassified', explanation: why };
    }
    const c = cats[idx]!;
    const better = cats[idx - 1];
    const missed = better ? groups.filter((g) => (g.score as number) > better.max[g.id]!).map((g) => `${g.name} ${g.score} > ${better.max[g.id]}`) : [];
    const pct = cats.length > 1 ? round1(((cats.length - 1 - idx) / (cats.length - 1)) * 100) : 100;
    return {
      score: idx, display: `Category ${c.id}`, pct, label: `Category ${c.id}`,
      explanation: `Category ${c.id}: the best category whose limits every dimension meets.${better ? ` Category ${better.id} is missed because ${missed.join('; ')}.` : ''} Fit for: ${c.use}`,
    };
  }
  if (s.scheme === 'points') {
    let m: number | null;
    let how: string;
    if (a.mode === 'itemized') {
      const levels = standard.groups.flatMap((g) => g.items).map((i) => verdictOf(a, i.id))
        .filter((v) => v !== 'n/a').map((v) => (typeof v === 'number' ? v : 0));
      m = mean(levels);
      how = `Mean of all ${levels.length} applicable criteria.`;
    } else {
      m = a.published?.overall ?? null;
      how = 'Overall score as published by the source.';
    }
    return m === null
      ? { score: null, display: 'n/a', pct: null, label: 'n/a', explanation: 'No applicable criteria.' }
      : { score: m, display: `${round1(m)} / ${s.max}`, pct: round1((m / s.max) * 100), label: `${round1(m)} / ${s.max}`, explanation: how };
  }
  const scored = groups.filter((g) => g.score !== null);
  const m = mean(scored.map((g) => g.score as number));
  return m === null
    ? { score: null, display: 'n/a', pct: null, label: 'n/a', explanation: 'No group could be scored.' }
    : {
        score: m, display: `${round1(m)}%`, pct: round1(m), label: `${round1(m)}%`,
        explanation: `Mean of ${scored.map((g) => `${g.name} ${g.display}`).join(', ')}.`,
      };
}

/** Published figures more than this far from the recomputation are flagged (allows for the source's own rounding). */
export const TOLERANCE = 0.1;

function fmt(v: number | 'invalid' | null | undefined): string {
  if (v === null || v === undefined) return 'not reported';
  return v === 'invalid' ? 'invalid' : `${round1(v)}`;
}

function discrepancies(standard: Standard, a: Assessment, groups: GroupResult[], overall: Result['overall']): Discrepancy[] {
  const out: Discrepancy[] = [];
  const p = a.published;
  if (!p) return out;
  for (const g of groups) {
    if (!p.groups || !(g.id in p.groups)) continue;
    const pub = p.groups[g.id];
    const comp: number | 'invalid' | null = g.state === 'invalid' ? 'invalid' : g.score;
    const same = typeof pub === 'number' && typeof comp === 'number' ? Math.abs(round1(pub) - round1(comp)) <= TOLERANCE + 1e-9 : pub === comp;
    if (!same) out.push({ field: g.name, published: fmt(pub), computed: fmt(comp) });
  }
  if (p.overall !== undefined && overall.score !== null && standard.scoring?.scheme !== 'aisl-severity') {
    if (Math.abs(round1(p.overall) - round1(overall.score)) > TOLERANCE + 1e-9)
      out.push({ field: 'Overall', published: fmt(p.overall), computed: fmt(overall.score) });
  }
  // Only a published category is comparable; a free-text verdict ("not suitable") is shown, not diffed.
  if (p.label?.startsWith('Category ') && standard.scoring?.scheme === 'aisl-severity' && p.label !== overall.label)
    out.push({ field: 'Category', published: p.label, computed: overall.label });
  return out;
}
