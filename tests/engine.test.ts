import { describe, expect, it } from 'vitest';
import { score, round1 } from '../src/engine.ts';
import { load } from '../src/load.ts';
import { validate } from '../src/validate.ts';
import type { Assessment, Standard } from '../src/schema.ts';

const corpus = load(new URL('..', import.meta.url).pathname);
const std = (id: string) => corpus.standards.find((s) => s.value.id === id)!.value;
const assessment = (b: string, s: string) => corpus.assessments.find((a) => a.value.benchmark === b && a.value.standard === s)!.value;

const base = (standard: Standard, verdicts: Record<string, Assessment['verdicts'] extends infer V ? V extends Record<string, infer X> ? X : never : never>): Assessment => ({
  benchmark: 'example', standard: standard.id, standard_version: standard.version, status: 'draft', mode: 'itemized',
  provenance: { kind: 'touchstone', assessors: ['a', 'b'], assessed_on: '2026-10-26' },
  verdicts, revisions: [{ date: '2026-10-26', by: 'test', summary: 'test' }],
});
const allItems = (s: Standard) => s.groups.flatMap((g) => g.items);
const v = (value: 'met' | 'unmet' | 'n/a' | number) => ({ value, evidence: [] });

describe('corpus', () => {
  it('validates with no errors', () => {
    expect(validate(corpus)).toEqual([]);
  });

  it('scores every assessment deterministically', () => {
    for (const { value: a } of corpus.assessments) {
      const s = std(a.standard);
      expect(score(s, a)).toEqual(score(s, structuredClone(a)));
    }
  });
});

describe('AISL severity scheme', () => {
  const s = std('aisl-scorecard');
  const allMet = Object.fromEntries(allItems(s).map((i) => [i.id, v('met')]));

  it('gives Category A when every item is met', () => {
    const r = score(s, base(s, allMet));
    expect(r.groups.every((g) => g.score === 1)).toBe(true);
    expect(r.overall.label).toBe('Category A');
  });

  it('caps a dimension at the worst unmet highlight colour', () => {
    // cv.03 is yellow (2), cv.12 orange (3): the dimension takes 3.
    const r = score(s, base(s, { ...allMet, 'cv.03': v('unmet'), 'cv.12': v('unmet') }));
    const cv = r.groups.find((g) => g.id === 'construct_validity')!;
    expect(cv.score).toBe(3);
    expect(cv.capped_by).toEqual(['cv.03', 'cv.12']);
    expect(r.overall.label).toBe('Category D');
  });

  it('invalidates a dimension when a baseline item is unmet', () => {
    const r = score(s, base(s, { ...allMet, 'cv.01': v('unmet') }));
    const cv = r.groups.find((g) => g.id === 'construct_validity')!;
    expect(cv.state).toBe('invalid');
    expect(cv.failed_baseline).toEqual(['cv.01']);
    expect(r.overall.label).toBe('Unclassified');
  });

  it('treats a missing verdict as unmet', () => {
    const { ['cv.01']: _drop, ...rest } = allMet;
    expect(score(s, base(s, rest)).groups[0]!.state).toBe('invalid');
  });

  it('ignores n/a items', () => {
    const r = score(s, base(s, { ...allMet, 'cv.12': v('n/a'), 'cv.13': v('n/a') }));
    expect(r.overall.label).toBe('Category A');
  });

  it('recomputes ImpossibleBench as Category C under the final table and flags the published B', () => {
    const r = score(s, assessment('impossiblebench', 'aisl-scorecard'));
    expect(r.overall.label).toBe('Category C');
    expect(r.discrepancies).toEqual([{ field: 'Category', published: 'Category B', computed: 'Category C' }]);
  });
});

describe('points scheme (BetterBench)', () => {
  const s = std('betterbench');

  it('averages applicable levels per stage and over all items', () => {
    const verdicts = Object.fromEntries(allItems(s).map((i, n) => [i.id, v(n % 2 ? 15 : 'n/a')]));
    const r = score(s, base(s, verdicts));
    expect(r.overall.score).toBe(15);
    expect(r.overall.pct).toBe(100);
  });

  it('reproduces published stage scores where the published criteria agree', () => {
    for (const id of ['truthfulqa', 'gpqa', 'mlcommons-ai-safety-v0-5', 'pdebench']) {
      expect(score(s, assessment(id, 'betterbench')).discrepancies).toEqual([]);
    }
  });

  it('flags BBQ, whose published stage scores disagree with its own criterion scores', () => {
    const fields = score(s, assessment('bbq', 'betterbench')).discrepancies.map((d) => d.field);
    expect(fields).toContain('Maintenance');
  });
});

describe('checklist scheme (ABC)', () => {
  const s = std('abc');

  it('scores a section as met / applicable', () => {
    const items = allItems(s);
    const verdicts = Object.fromEntries(items.map((i) => [i.id, v(i.id.startsWith('O.') ? 'n/a' : 'met')]));
    verdicts['O.a.1'] = v('met');
    verdicts['O.a.2'] = v('unmet');
    const r = score(s, base(s, verdicts));
    expect(r.groups.find((g) => g.id === 'outcome_validity')!.score).toBe(50);
  });

  it('reproduces every published ABC overall score as the mean of its sections', () => {
    for (const { value: a } of corpus.assessments.filter((x) => x.value.standard === 'abc')) {
      expect(score(s, a).discrepancies).toEqual([]);
    }
  });
});

describe('round1', () => {
  it('rounds half up', () => {
    expect(round1(1.25)).toBe(1.3);
    expect(round1(9.95)).toBe(10);
    expect(round1(0.05)).toBe(0.1);
  });
});
