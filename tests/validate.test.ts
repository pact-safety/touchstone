import { describe, expect, it } from 'vitest';
import { load, type Corpus } from '../src/load.ts';
import { validate } from '../src/validate.ts';
import type { Assessment } from '../src/schema.ts';

const real = load(new URL('..', import.meta.url).pathname);
const bench = real.benchmarks[0]!;
const aisl = real.standards.find((s) => s.value.id === 'aisl-scorecard')!.value;
const points = real.standards.find((s) => s.value.id === 'betterbench')!.value;
const checklist = real.standards.find((s) => s.value.id === 'abc')!.value;
const ARXIV = 'https://arxiv.org/abs/2501.12345v2';
const first = aisl.groups[0]!.items[0]!.id;

type Kind = Assessment['provenance']['kind'];
/** A one-assessment corpus whose only verdict is `first` = met with the given evidence; returns validation errors. */
function run(kind: Kind, over: Partial<Assessment> = {}, evidence: { url: string; quote?: string } | null = { url: ARXIV }, by?: 'model' | 'human', verified?: boolean): string[] {
  const a: Assessment = {
    benchmark: bench.value.id, standard: aisl.id, standard_version: aisl.version, status: 'draft', mode: 'itemized',
    provenance: { kind, assessors: ['Ann', 'Bob'], assessed_on: '2026-10-26', ...(kind === 'external' ? { source_url: 'https://example.org' } : {}) },
    verdicts: { [first]: { value: 'met', by, quotes_verified: verified, evidence: evidence ? [{ source: 'paper', locator: 'p1', ...evidence }] : [] } },
    revisions: [{ date: '2026-10-26', by: 'test', summary: 'test' }],
    ...(kind === 'automated' ? { model_run: { model: real.models[0]?.id ?? 'm', provider: 'p', license: 'l', temperature: 0, seed: 1, prompt_version: '1', run_on: '2026-10-26', transcript: 't', sources: [{ kind: 'paper', url: ARXIV, ref: 'v2', sha256: 'a'.repeat(64), chars: 1 }] } } : {}),
    ...over,
  };
  const file = kind === 'automated' ? `${a.standard}.auto` : a.standard;
  const c: Corpus = { ...real, errors: [], assessments: [{ path: `data/assessments/${a.benchmark}/${file}.yaml`, value: a }] };
  return validate(c);
}
const mentions = (errs: string[], s: string) => errs.filter((e) => e.includes(s));

describe('validate: automated quotes', () => {
  it('requires quotes_verified on any verdict with a quote, with or without `by`', () => {
    const q = { url: ARXIV, quote: 'x' };
    expect(mentions(run('automated', {}, q, undefined), 'were not verified')).toHaveLength(1);
    expect(mentions(run('automated', {}, q, 'human'), 'were not verified')).toHaveLength(1);
    expect(mentions(run('automated', {}, q, 'model', true), 'were not verified')).toEqual([]);
  });
});

describe('validate: immutable evidence urls', () => {
  const bad = (kind: Kind, url: string) => mentions(run(kind, {}, { url }), 'immutable');
  it('accepts versioned arXiv, commit-pinned GitHub and archive snapshots', () => {
    for (const url of [
      'https://arxiv.org/pdf/2501.12345v1',
      `https://github.com/o/r/blob/${'a'.repeat(40)}/README.md#L3`,
      `https://github.com/o/r/tree/${'0'.repeat(40)}/src`,
      'https://web.archive.org/web/20260101000000/https://example.org/',
    ]) expect(bad('touchstone', url)).toEqual([]);
  });
  it('rejects mutable references for touchstone and automated', () => {
    for (const url of ['https://arxiv.org/abs/2501.12345', 'https://github.com/o/r/blob/main/README.md', `https://github.com/o/r/blob/${'a'.repeat(39)}/x`, 'https://example.org/page'])
      for (const kind of ['touchstone', 'automated'] as const) expect(bad(kind, url)).toHaveLength(1);
  });
  it('exempts external assessments', () => {
    expect(bad('external', 'https://example.org/page')).toEqual([]);
  });
});

describe('validate: assessors', () => {
  it('rejects the same person listed twice, ignoring case and spaces', () => {
    expect(mentions(run('touchstone', { provenance: { kind: 'touchstone', assessors: ['Ann', ' ann '], assessed_on: '2026-10-26' } }), 'distinct')).toHaveLength(1);
    expect(mentions(run('touchstone'), 'distinct')).toEqual([]);
  });
});

describe('validate: published ranges', () => {
  const pub = (std: typeof aisl, published: NonNullable<Assessment['published']>) =>
    run('external', { standard: std.id, standard_version: std.version, mode: 'imported', verdicts: undefined, scores: {}, published }, null)
      .filter((e) => e.includes('published.'));
  const g = (std: typeof aisl) => std.groups[0]!.id;
  it('points: 0..max', () => {
    expect(pub(points, { overall: 16 })).toHaveLength(1);
    expect(pub(points, { overall: 15, groups: { [g(points)]: -1 } })).toHaveLength(1);
    expect(pub(points, { overall: 15, groups: { [g(points)]: 0 } })).toEqual([]);
  });
  it('checklist: 0..100', () => {
    expect(pub(checklist, { overall: 101 })).toHaveLength(1);
    expect(pub(checklist, { overall: 100, groups: { [g(checklist)]: 100 } })).toEqual([]);
  });
  it('aisl: 1..4', () => {
    expect(pub(aisl, { overall: 5 })).toHaveLength(1);
    expect(pub(aisl, { groups: { [g(aisl)]: 0 } })).toHaveLength(1);
    expect(pub(aisl, { groups: { [g(aisl)]: 4 } })).toEqual([]);
  });
});
