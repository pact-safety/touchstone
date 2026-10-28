import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, decodeView, encodeView } from '../site/src/hashstate.ts';

const ok = { sorts: ['touchstone', 'run', 'name', 'domain', 'abc'], modalities: ['lm-agent', 'classifier'], benchmarks: new Set(['a', 'b', 'c', 'd', 'e']) };

describe('ratings hash state', () => {
  it('encodes the defaults as a bare #/', () => {
    expect(encodeView(DEFAULT_VIEW)).toBe('#/');
    expect(decodeView('', ok)).toEqual(DEFAULT_VIEW);
  });
  it('round-trips every field', () => {
    const v = { q: 'web arena', domain: 'safety', modality: 'lm-agent', source: 'published', value: 'best', sort: 'abc', dir: 1, compare: ['a', 'b'] };
    const h = encodeView(v);
    expect(h).toBe('#/?q=web+arena&domain=safety&type=lm-agent&source=published&value=best&sort=abc&dir=asc&compare=a,b');
    expect(decodeView(h.split('?')[1]!, ok)).toEqual(v);
  });
  it('omits dir when it is the sort column default', () => {
    expect(encodeView({ ...DEFAULT_VIEW, sort: 'run', dir: 1 })).toBe('#/?sort=run');
    expect(encodeView({ ...DEFAULT_VIEW, sort: 'run', dir: -1 })).toBe('#/?sort=run&dir=desc');
  });
  it('drops invalid values and caps compare at 4 known ids', () => {
    const v = decodeView('domain=x&sort=nope&type=zzz&source=bad&compare=a,a,zz,b,c,d,e', ok);
    expect(v).toEqual({ ...DEFAULT_VIEW, compare: ['a', 'b', 'c', 'd'] });
  });
});
