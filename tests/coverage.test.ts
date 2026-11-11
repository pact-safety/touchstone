import { describe, expect, it } from 'vitest';
import { CATS, categorize, coverage } from '../site/src/coverage.ts';

const standards = [
  { id: 's1', status: 'encoded' },
  { id: 's2', status: 'encoded', scope: { domains: ['safety'] } },
  { id: 's3', status: 'paywalled' },
];
const benchmarks = [
  { id: 'a', domain: 'safety', modality: 'lm-agent' },
  { id: 'b', domain: 'capability', modality: 'classifier' },
  { id: 'c', domain: 'capability', modality: 'lm-agent' },
];
const summaries = [
  { benchmark: 'a', standard: 's1', status: 'draft' },
  { benchmark: 'a', standard: 's1', status: 'published' },
  { benchmark: 'b', standard: 's1', status: 'draft' },
];

describe('coverage categories', () => {
  it('puts every benchmark x standard pair in exactly one category', () => {
    const c = coverage(standards, benchmarks, summaries);
    expect(CATS.reduce((n, k) => n + c.counts[k], 0)).toBe(standards.length * benchmarks.length);
    expect(c.counts).toEqual({ reviewed: 1, draft: 1, pending: 2, na: 2, blocked: 3 });
  });
  it('lets a published summary win over a draft', () => {
    expect(categorize(standards[0]!, benchmarks[0]!, summaries)).toBe('reviewed');
    expect(categorize(standards[0]!, benchmarks[1]!, summaries)).toBe('draft');
  });
  it('splits unassessed pairs by scope and sorts columns by domain then modality', () => {
    expect(categorize(standards[1]!, benchmarks[1]!, summaries)).toBe('na');
    expect(categorize(standards[1]!, benchmarks[0]!, summaries)).toBe('pending');
    expect(coverage(standards, benchmarks, summaries).cols.map((b) => b.id)).toEqual(['b', 'c', 'a']);
  });
  it('computes the reviewed share of rateable pairs', () => {
    expect(coverage(standards, benchmarks, summaries).reviewedShare).toBeCloseTo(1 / 4);
  });
});
