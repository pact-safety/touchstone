import { describe, expect, it } from 'vitest';
import { score, improvements, round1 } from '../src/engine.ts';
import { load } from '../src/load.ts';
import { validate } from '../src/validate.ts';
import type { Assessment, Standard } from '../src/schema.ts';

const corpus = load(new URL('..', import.meta.url).pathname);
const std = (id: string) => corpus.standards.find((s) => s.value.id === id)!.value;
const assessment = (b: string, s: string) => corpus.assessments.find((a) => a.value.benchmark === b && a.value.standard === s && a.value.provenance.kind !== 'automated')!.value;

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

  it('leaves a group with only n/a items unscored, which makes the overall Unclassified with no bar', () => {
    const cv = s.groups.find((g) => g.id === 'construct_validity')!;
    const r = score(s, base(s, { ...allMet, ...Object.fromEntries(cv.items.map((i) => [i.id, v('n/a')])) }));
    const g = r.groups.find((x) => x.id === 'construct_validity')!;
    expect([g.state, g.score, g.pct]).toEqual(['unscored', null, null]);
    expect([r.overall.label, r.overall.pct]).toEqual(['Unclassified', null]);
  });

  it('gives an invalid dimension no bar', () => {
    const r = score(s, base(s, { ...allMet, 'cv.01': v('unmet') }));
    expect(r.groups[0]!.pct).toBeNull();
  });

  it('adds no category discrepancy to a label-only import', () => {
    const a: Assessment = { ...base(s, {}), mode: 'imported', verdicts: undefined, published: { label: 'Category B' } };
    expect(score(s, a).discrepancies).toEqual([]);
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
    const verdicts = Object.fromEntries(s.groups.flatMap((g) => g.items.map((i, n) => [i.id, v(n % 2 ? 15 : 'n/a')])));
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

  it('is Incomplete, with no score, when a section has no applicable items; imports keep the mean', () => {
    const verdicts = Object.fromEntries(allItems(s).map((i) => [i.id, v(i.id.startsWith('O.') ? 'n/a' : 'met')]));
    const r = score(s, base(s, verdicts));
    expect([r.overall.label, r.overall.score, r.overall.pct]).toEqual(['Incomplete', null, null]);
    expect(r.overall.explanation).toContain(s.groups.find((g) => g.id === 'outcome_validity')!.name);
    const imp: Assessment = { ...base(s, {}), mode: 'imported', verdicts: undefined, scores: { task_validity: 80, outcome_validity: null } };
    expect(score(s, imp).overall.score).toBe(80);
  });

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

describe('improvements', () => {
  const key = (r: ReturnType<typeof improvements>) => r.map((x) => x.item);

  it('AISL: the one unmet baseline item is the top suggestion and unblocks the category', () => {
    const s = std('aisl-scorecard');
    const allMet = Object.fromEntries(allItems(s).map((i) => [i.id, v('met')]));
    const a = base(s, { ...allMet, 'cv.01': v('unmet') });
    const r = improvements(s, a);
    expect(r[0]).toMatchObject({ item: 'cv.01', groupFrom: 'Invalid', groupTo: '1', overallFrom: 'Unclassified', overallTo: 'Category A', blocking: true });
    expect(r).toEqual(improvements(s, structuredClone(a)));
    expect(improvements(s, base(s, allMet))).toEqual([]);
  });

  it('AISL: drops items that change nothing, ranks the rest by overall then group gain then id, and honours the limit', () => {
    const s = std('aisl-scorecard');
    const allMet = Object.fromEntries(allItems(s).map((i) => [i.id, v('met')]));
    // cv.03 (yellow) is masked by cv.12 (orange): fixing it alone changes nothing.
    const a = base(s, { ...allMet, 'cv.03': v('unmet'), 'cv.12': v('unmet'), 'ev.07': v('unmet') });
    const r = improvements(s, a);
    expect(key(r)).toEqual(['ev.07', 'cv.12']); // fixing ev.07 moves the overall category further
    expect(improvements(s, a, 1)).toHaveLength(1);
  });

  it('points: lifting an item to the top level raises the stage and overall', () => {
    const s = std('betterbench');
    const a = base(s, Object.fromEntries(allItems(s).map((i) => [i.id, v(15)])));
    const first = allItems(s)[0]!.id;
    a.verdicts![first] = v(0);
    const r = improvements(s, a);
    expect(r[0]).toMatchObject({ item: first, overallTo: '15 / 15', blocking: false });
    expect(r[0]!.overallFrom).not.toBe('15 / 15');
  });

  it('checklist: a met-able item changes its section and ranks by overall gain', () => {
    const s = std('abc');
    const a = base(s, Object.fromEntries(allItems(s).map((i) => [i.id, v('met')])));
    a.verdicts!['O.a.1'] = v('unmet');
    const r = improvements(s, a);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ item: 'O.a.1', overallTo: '100%' });
  });

  it('returns nothing for imported assessments', () => {
    const s = std('abc');
    expect(improvements(s, { ...base(s, {}), mode: 'imported', verdicts: undefined, scores: { task_validity: 50 } })).toEqual([]);
  });
});

describe('round1', () => {
  it('rounds half up', () => {
    expect(round1(1.25)).toBe(1.3);
    expect(round1(9.95)).toBe(10);
    expect(round1(0.05)).toBe(0.1);
  });
});
