import { describe, expect, it } from 'vitest';
import type { Result } from '../src/engine.ts';
import type { Assessment, Resources, Standard } from '../src/schema.ts';
import { frontier, normalize, rigor, rigorInputs, runProfile, type RigorInput } from '../src/touchstone.ts';

const std = (scheme: string, id = 'x') => ({ id, short: id.toUpperCase(), status: 'encoded', scoring: { scheme } }) as unknown as Standard;
const res = (label: string, pct: number | null) => ({ overall: { label, pct } }) as unknown as Result;
const inp = (normalized: number | null, short = 'S'): RigorInput => ({ standard: short.toLowerCase(), short, label: '', normalized, provenance: 'touchstone' });
const of = (...xs: number[]) => rigor(xs.map((x, i) => inp(x, `S${i}`)));

describe('normalize', () => {
  it('maps AISL categories to 100..20, Unclassified to 0 and Incomplete to null', () => {
    const s = std('aisl-severity');
    expect(['A', 'B', 'C', 'D', 'E'].map((c) => normalize(s, res(`Category ${c}`, 50)))).toEqual([100, 80, 60, 40, 20]);
    expect(normalize(s, res('Unclassified', null))).toBe(0);
    expect(normalize(s, res('Incomplete', null))).toBeNull();
  });
  it('uses the overall percent for points and checklist standards', () => {
    expect(normalize(std('points'), res('3 / 4', 75))).toBe(75);
    expect(normalize(std('checklist'), res('61.2%', 61.2))).toBe(61.2);
    expect(normalize(std('checklist'), res('Incomplete', null))).toBeNull();
    expect(normalize(std('points'), res('n/a', null))).toBeNull();
  });
});

describe('rigor', () => {
  it('takes the median for odd and even counts', () => {
    expect(of(10, 90, 60).score).toBe(60);
    expect(of(60, 80, 10, 90).score).toBe(70);
    expect(of(61.25).score).toBe(61.3);
  });
  it('grades at each boundary', () => {
    const g = (x: number) => of(x).grade;
    expect([85, 84.9, 70, 69.9, 55, 54.9, 40, 39.9, 25, 24.9].map(g)).toEqual(['A', 'B', 'B', 'C', 'C', 'D', 'D', 'E', 'E', 'F']);
    expect(rigor([]).grade).toBeNull();
    expect(rigor([inp(null)]).n).toBe(0);
  });
  it('reports spread and agreement', () => {
    expect(of(50).agreement).toBe('single');
    expect(of(50, 65).agreement).toBe('high');
    expect(of(50, 65.1).agreement).toBe('moderate');
    expect(of(50, 80).agreement).toBe('moderate');
    expect(of(50, 80.1).agreement).toBe('low');
    expect(of(50, 70).spread).toBe(20);
  });
  it('sets confidence from the count and agreement', () => {
    expect(of(60).confidence).toBe('low');
    expect(of(60, 70).confidence).toBe('medium');
    expect(of(10, 90).confidence).toBe('low');
    expect(of(60, 70, 75).confidence).toBe('high');
    expect(of(40, 60, 70).confidence).toBe('high');
    expect(of(10, 50, 90).confidence).toBe('medium');
  });
  it('checks that the grade survives every cutpoint shifted by 5 either way', () => {
    expect(of(60).gradeStable).toBe(true); // C holds from 50 to 60
    expect(of(75).gradeStable).toBe(true); // B holds from 65 to 75
    expect(of(100).gradeStable).toBe(true);
    expect(of(58).gradeStable).toBe(false); // C, but D once the C cut is 60
    expect(of(72).gradeStable).toBe(false); // B, but C once the B cut is 75
  });
  it('writes a plain explanation and leaves incomplete inputs out of the count', () => {
    const r = rigor([inp(61, 'BetterBench'), inp(72, 'ABC'), inp(60, 'AISL'), inp(null, 'STREAM')]);
    expect(r.explanation).toContain('Median of 3 standards (BetterBench 61, ABC 72, AISL 60) = 61 → C. Spread 12 → high agreement; confidence high.');
    expect(r.n).toBe(3);
    expect(r.inputs).toHaveLength(4);
  });
});

describe('rigorInputs', () => {
  it('counts only published assessments and prefers touchstone over external over automated', () => {
    const full = { id: 'abc', short: 'ABC', status: 'encoded', groups: [{ id: 'g', name: 'G', items: [] }], scoring: { scheme: 'checklist', overall: 'mean-of-groups' } } as unknown as Standard;
    const a = (kind: string, status: string, pct: number) =>
      ({ benchmark: 'b', standard: 'abc', status, mode: 'imported', scores: { g: pct }, provenance: { kind, assessors: ['x'], assessed_on: '2026-10-26' } }) as unknown as Assessment;
    const pick = (...as: Assessment[]) => rigorInputs([full], as).map((i) => [i.provenance, i.normalized]);
    expect(pick(a('automated', 'published', 10), a('external', 'published', 20), a('touchstone', 'draft', 30))).toEqual([['external', 20]]);
    expect(pick(a('automated', 'published', 10), a('touchstone', 'published', 30))).toEqual([['touchstone', 30]]);
    expect(pick(a('touchstone', 'draft', 30))).toEqual([]);
  });
});

const R = (over: Partial<Resources> = {}): Resources => ({
  items: 1000, interaction: 'single-turn', model_calls_per_item: 1, tokens_per_call: 1000, grading: 'exact', judge_calls_per_item: 0,
  environment: 'none', gpu_required: false, disk_gb: 1, estimate_basis: 'x', sources: [{ url: 'https://example.com', locator: 'l' }], ...over,
});
const pricing = { as_of: '2026-10-26', low_usd_per_mtok: 0.1, high_usd_per_mtok: 15 };

describe('runProfile', () => {
  it('returns null without resources', () => expect(runProfile(undefined, pricing)).toBeNull());
  it('counts judge calls and rounds cost to 2 significant figures', () => {
    const p = runProfile(R({ items: 817, judge_calls_per_item: 1, grading: 'llm-judge', tokens_per_call: 500 }), pricing)!;
    expect(p.tokens).toBe(817_000);
    expect(p.costUsd).toEqual([0.082, 12]);
  });
  it('sets the API tier at each boundary', () => {
    const tier = (tokens: number) => runProfile(R({ items: tokens, tokens_per_call: 1 }), pricing)!.apiTier;
    expect([999_999, 1e6, 9_999_999, 1e7, 99_999_999, 1e8, 999_999_999, 1e9].map(tier)).toEqual(['$', '$$', '$$', '$$$', '$$$', '$$$$', '$$$$', '$$$$$']);
  });
  it('has no API cost for non-llm benchmarks', () => {
    const p = runProfile(R({ interaction: 'non-llm', model_calls_per_item: 0, tokens_per_call: 0 }), pricing)!;
    expect([p.tokens, p.apiTier, p.costUsd]).toEqual([0, 'none', [0, 0]]);
  });
  it('sets the local tier in order, covering the harness only', () => {
    const tier = (o: Partial<Resources>) => runProfile(R(o), pricing)!.localTier;
    expect(tier({})).toBe('Lite');
    expect(tier({ disk_gb: 5 })).toBe('Lite');
    expect(tier({ disk_gb: 5.1 })).toBe('Standard');
    expect(tier({ environment: 'docker' })).toBe('Standard');
    expect(tier({ environment: 'simulator' })).toBe('Standard');
    expect(tier({ environment: 'live-web' })).toBe('Standard');
    expect(tier({ interaction: 'agentic' })).toBe('Standard');
    expect(tier({ disk_gb: 50 })).toBe('Standard');
    expect(tier({ disk_gb: 50.1 })).toBe('Heavy');
    expect(tier({ gpu_required: true })).toBe('Heavy');
    expect(tier({ environment: 'vm', items: 500 })).toBe('Heavy');
    expect(tier({ environment: 'vm', items: 501 })).toBe('Extreme');
    expect(tier({ disk_gb: 500 })).toBe('Heavy');
    expect(tier({ disk_gb: 500.1 })).toBe('Extreme');
    expect(runProfile(R(), pricing)!.explanation).toContain('not hosting the model under test');
  });
});

describe('frontier', () => {
  it('keeps benchmarks no other benchmark beats on both score and tokens', () => {
    const rows = [
      { id: 'cheap-good', score: 80, tokens: 100 },
      { id: 'dominated', score: 70, tokens: 200 },
      { id: 'tie', score: 80, tokens: 100 },
      { id: 'costly-best', score: 90, tokens: 1000 },
      { id: 'cheapest', score: 50, tokens: 10 },
      { id: 'no-score', score: null, tokens: 5 },
      { id: 'non-llm', score: 99, tokens: null },
    ];
    expect([...frontier(rows)].sort()).toEqual(['cheap-good', 'cheapest', 'costly-best', 'tie']);
  });
});
