import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, decodeView, encodeView } from '../site/src/hashstate.ts';

const ok = { sorts: ['touchstone', 'run', 'name', 'domain', 'abc'], modalities: ['lm-agent', 'classifier'], benchmarks: new Set(['a', 'b', 'c', 'd', 'e']), standards: ['s1', 's2', 's3'] };

describe('ratings hash state', () => {
  it('encodes the defaults as a bare #/', () => {
    expect(encodeView(DEFAULT_VIEW)).toBe('#/');
    expect(decodeView('', ok)).toEqual(DEFAULT_VIEW);
  });
  it('round-trips every field', () => {
    const v = { q: 'web arena', domain: 'safety', modality: 'lm-agent', source: 'automated', value: 'best', sort: 'abc', dir: 1, compare: ['a', 'b'], stds: ['s1', 's3'] };
    const h = encodeView(v);
    expect(h).toBe('#/?q=web+arena&domain=safety&type=lm-agent&source=automated&value=best&sort=abc&dir=asc&compare=a,b&stds=s1,s3');
    expect(decodeView(h.split('?')[1]!, ok)).toEqual(v);
  });
  it('defaults source to published and encodes all explicitly', () => {
    expect(decodeView('', ok).source).toBe('published');
    expect(encodeView({ ...DEFAULT_VIEW, source: 'all' })).toBe('#/?source=all');
  });
  it('omits dir when it is the sort column default', () => {
    expect(encodeView({ ...DEFAULT_VIEW, sort: 'run', dir: 1 })).toBe('#/?sort=run');
    expect(encodeView({ ...DEFAULT_VIEW, sort: 'run', dir: -1 })).toBe('#/?sort=run&dir=desc');
  });
  it('drops invalid values and caps compare at 4 known ids', () => {
    const v = decodeView('domain=x&sort=nope&type=zzz&source=bad&compare=a,a,zz,b,c,d,e', ok);
    expect(v).toEqual({ ...DEFAULT_VIEW, compare: ['a', 'b', 'c', 'd'] });
  });
  it('round-trips a custom standard set and "all"', () => {
    expect(encodeView({ ...DEFAULT_VIEW, stds: ['s2', 's1'] })).toBe('#/?stds=s2,s1');
    expect(decodeView('stds=s2,s1', ok).stds).toEqual(['s2', 's1']);
    expect(encodeView({ ...DEFAULT_VIEW, stds: ['all'] })).toBe('#/?stds=all');
    expect(decodeView('stds=all', ok).stds).toEqual(['all']);
  });
  it('drops unknown and duplicate standard ids; the default set stays out of the URL', () => {
    expect(decodeView('stds=s1,zz,s1,s3', ok).stds).toEqual(['s1', 's3']);
    expect(decodeView('stds=zz', ok).stds).toEqual([]);
    expect(encodeView(DEFAULT_VIEW)).not.toContain('stds');
  });
});
