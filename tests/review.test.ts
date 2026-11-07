import { describe, expect, it } from 'vitest';
import { applyPair, evidenceSources, readDocs, readingsFromRows } from '../scripts/apply-review.ts';
import { MODEL_A, MODEL_B, crosscheck, disagreement } from '../scripts/crosscheck.ts';
import type { Corpus } from '../src/load.ts';
import { Revision } from '../src/schema.ts';

const ev = (quote: string) => [{ source: 'paper', url: 'https://arxiv.org/abs/1.0v1', locator: 'p1', quote }];
const v = (value: unknown, extra: object = {}) => ({ value, rationale: 'r', evidence: ev('q'), by: 'model', quotes_verified: true, ...extra });

const std = { id: 's', name: 'Std', groups: [{ id: 'g', name: 'Group', items: [{ id: 'i1', text: 'T1', guidance: { met: 'M1' } }, { id: 'i2', text: 'T2' }, { id: 'i3', text: 'T3' }, { id: 'i4', text: 'T4' }] }] };
const asm = (model: string, verdicts: Record<string, unknown>) => ({ path: 'p', value: { benchmark: 'b', standard: 's', model_run: { model }, verdicts } });
const corpus = (assessments: unknown[]) =>
  ({ standards: [{ value: std }], benchmarks: [{ value: { id: 'b', name: 'Bench' } }], assessments }) as unknown as Corpus;

describe('agreement rule', () => {
  const a = v('met') as any;
  it('agrees on the same value', () => expect(disagreement(a, v('met') as any)).toBeNull());
  it('flags differing values, unverified A quotes and missing B', () => {
    expect(disagreement(a, v('unmet') as any)).toBe('values differ');
    expect(disagreement(v('met', { quotes_verified: false }) as any, v('met') as any)).toBe('A quotes unverified');
    expect(disagreement(a, undefined)).toBe('B missing');
  });
  it('compares numeric scales by value', () => {
    expect(disagreement(v(10) as any, v(10) as any)).toBeNull();
    expect(disagreement(v(10) as any, v(5) as any)).toBe('values differ');
  });
  it('treats an absent quotes_verified as not unverified', () =>
    expect(disagreement(v('met', { quotes_verified: undefined }) as any, v('met') as any)).toBeNull());
});

describe('crosscheck', () => {
  const A = asm(MODEL_A, { i1: v('met'), i2: v('met'), i3: v('met', { quotes_verified: false }), i4: v('met') });
  it('counts agreed and builds rows with reasons', () => {
    const B = asm(MODEL_B, { i1: v('met'), i2: v('unmet'), i3: v('met') });
    const r = crosscheck(corpus([A]), corpus([B]), '2026-10-30');
    expect(r.pairs).toEqual([{ id: 'b~s', benchmark: 'b', standard: 's', items: 4, agreed: 1, to_review: 3 }]);
    expect(r.standards).toEqual([{ id: 's', title: 'Std', pairs: 1, items: 4, agreed: 1, to_review: 3 }]);
    expect(r.rows.map((x) => [x.key, x.reason])).toEqual([['b~s~i2', 'values differ'], ['b~s~i3', 'A quotes unverified'], ['b~s~i4', 'B missing']]);
    expect(r.rows[0]).toMatchObject({ benchmark_title: 'Bench', standard_title: 'Std', group: 'Group', text: 'T2', b: { value: 'unmet' } });
    expect(r.rows[2]!.b).toBeNull();
  });
  it('treats a B file that is a copy of A (wrong model) as missing', () => {
    const r = crosscheck(corpus([A]), corpus([asm(MODEL_A, A.value.verdicts)]));
    expect(r.pairs[0]).toMatchObject({ agreed: 0, to_review: 4 });
  });
});

describe('apply rules', () => {
  const doc = () => ({
    benchmark: 'b', standard: 's', status: 'draft', provenance: { kind: 'automated', assessors: ['m'] },
    verdicts: { i1: v('met'), i2: v('met'), i3: v('met') }, revisions: [{ date: '2026-10-29', by: 'm', summary: 's' }],
  });
  const bDoc = { verdicts: { i2: v('unmet', { rationale: 'from B', evidence: [] }), i3: v('unmet') } };
  const pair = { id: 'b~s', benchmark: 'b', standard: 's', items: 3, agreed: 1, to_review: 2 };
  const rows = [{ item: 'i2' }, { item: 'i3' }] as any;
  const run = (choices: any, approved = false) => applyPair(doc(), pair, rows, choices, bDoc, approved, '2026-10-30');

  it('a keeps the verdict and marks it human; b copies B; skip leaves it', () => {
    const r = run({ i2: 'b', i3: 'skip' });
    expect(r.doc.verdicts.i2).toMatchObject({ value: 'unmet', rationale: 'from B', evidence: [], by: 'human' });
    expect(r.doc.verdicts.i3).toEqual(v('met'));
    const a = run({ i2: 'a' });
    expect(a.doc.verdicts.i2).toMatchObject({ value: 'met', by: 'human' });
    expect(a.doc.status).toBe('draft');
  });
  it('publishes an approved pair with every row decided', () => {
    const r = run({ i2: 'a', i3: 'b' }, true);
    expect(r.published).toBe(true);
    expect(r.doc).toMatchObject({ status: 'published', provenance: { reviewers: ['Li Bearden'] } });
    const rev = r.doc.revisions.at(-1);
    expect(Revision.parse(rev).summary).toBe(`Reviewed against a ${MODEL_B} cross-check: 1 verdicts agreed, 2 decided by the reviewer.`);
    expect(rev.by).toBe('Li Bearden');
  });
  it('keeps existing reviewers and leaves an approved pair with a skip as draft', () => {
    const d = doc() as any;
    d.provenance.reviewers = ['Someone'];
    expect(applyPair(d, pair, rows, { i2: 'a', i3: 'a' }, bDoc, true, '2026-10-30').doc.provenance.reviewers).toEqual(['Someone', 'Li Bearden']);
    const r = run({ i2: 'a', i3: 'skip' }, true);
    expect(r.published).toBe(false);
    expect(r.doc.status).toBe('draft');
    expect(r.note).toMatch(/skipped or undecided/);
  });
  describe('adjudicated choices', () => {
    const adjudicator = (item: string) => (item === 'i2' ? 'adjudicator-v4' : undefined);
    const apply = (choices: any, approved = false) => applyPair(doc(), pair, rows, choices, bDoc, approved, '2026-10-30', adjudicator);

    it('stay by model and name the adjudicator; a person\'s choice is by human', () => {
      const r = apply({ i2: 'b', i3: 'a' });
      expect(r.doc.verdicts.i2).toMatchObject({ value: 'unmet', by: 'model', adjudicated_by: 'adjudicator-v4' });
      expect(r.doc.verdicts.i3).toMatchObject({ by: 'human' });
      expect(r.doc.verdicts.i3.adjudicated_by).toBeUndefined();
    });
    it('say so in the revision when published, listing every changed item', () => {
      const rev = apply({ i2: 'b', i3: 'a' }, true).doc.revisions.at(-1);
      expect(rev.summary).toBe(`Reviewed against a ${MODEL_B} cross-check: 1 verdicts agreed, 1 settled by adjudicator-v4, 1 decided by the reviewer. Approved by the reviewer at the level of the standard; rows settled by adjudicator-v4 were not checked one by one.`);
      expect(rev.items).toEqual(['status', 'i2']);
    });
    it('add a revision for a changed draft, by the adjudicator when no person chose', () => {
      const r = applyPair(doc(), pair, [{ item: 'i2' }] as any, { i2: 'b' }, bDoc, false, '2026-10-30', adjudicator);
      expect(r.doc.status).toBe('draft');
      expect(r.doc.revisions.at(-1)).toMatchObject({ by: 'adjudicator-v4', items: ['i2'] });
    });
    it('add no revision when no verdict changed', () => expect(apply({ i2: 'a' }).doc.revisions).toHaveLength(1));
  });
  it('does not publish when choice b has no B verdict', () => expect(applyPair(doc(), pair, rows, { i2: 'a', i3: 'b' }, undefined, true, '2026-10-30').published).toBe(false));
});

describe('rebuilding B from review rows', () => {
  const url = 'https://arxiv.org/abs/1.0v1';
  const assessment = (benchmark: string, source: string) => ({ value: { benchmark, verdicts: { i1: { evidence: [{ source, url }] } } } });
  const reading = (u: string) => ({ value: 'met', rationale: 'r', evidence: [{ quote: 'q', locator: 'p1', url: u }], quotes_verified: true }) as any;

  it('looks up a source from the same benchmark only', () => {
    expect(evidenceSources([assessment('b', 'paper'), assessment('other', 'repo')], 'b').get(url)).toBe('paper');
    expect(evidenceSources([assessment('other', 'repo')], 'b').has(url)).toBe(false);
  });
  it('leaves out a URL recorded under two source kinds', () =>
    expect(evidenceSources([assessment('b', 'paper'), assessment('b', 'repo')], 'b').has(url)).toBe(false));
  it('adds the source to each quote', () =>
    expect(readingsFromRows([{ item: 'i1', b: reading(url) }], new Map([[url, 'paper']])).verdicts.i1.evidence[0]).toEqual({ source: 'paper', quote: 'q', locator: 'p1', url }));
  it('fails closed: a row with an unknown URL or no reading is left out', () => {
    expect(readingsFromRows([{ item: 'i1', b: reading('https://example.org/x') }, { item: 'i2', b: null }], new Map([[url, 'paper']])).verdicts).toEqual({});
  });
});

describe('readDocs', () => {
  it('accepts a bare array, a wrapped list, and empty text', () => {
    expect(readDocs('[{"id":"x","data":{"approved":true}}]')).toEqual([{ id: 'x', data: { approved: true } }]);
    expect(readDocs('{"documents":[{"id":"x","data":{"a":1}}]}')[0]!.data).toEqual({ a: 1 });
    expect(readDocs('')).toEqual([]);
  });
});
