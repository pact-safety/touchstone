import { describe, expect, it } from 'vitest';
import { citations, itemLines, levelLine, poolQuotes, settle, type Reply, type SettleIn } from '../scripts/adjudicate.ts';
import { readFileSync } from 'node:fs';

const MET = 'The paper states the dataset size and the paper states the split.';
const reply = (conds: [string, number[]][], extra: Partial<Reply> = {}): Reply => ({
  item: 'i', conditions: conds.map(([condition, q]) => ({ condition, quotes: q.map(String), reason: 'r' })), ...extra,
});
const both = reply([['the paper states the dataset size', [1]], ['the paper states the split', [2]]]);
const base: SettleIn = { standard: 's', item: 'i', met: MET, hasNa: false, points: false, nQuotes: 2, a: 'met', b: 'unmet', reply: both };

describe('settle: checklist', () => {
  it('met when every condition has a quote, and picks the matching reading', () => {
    expect(settle(base)).toMatchObject({ value: 'met', choice: 'a', rule: 'met: 2 of 2 conditions stated by a quote' });
    expect(settle({ ...base, a: 'unmet', b: 'met' })).toMatchObject({ value: 'met', choice: 'b' });
  });
  it('unmet when a condition has none, citing absence', () => {
    const s = settle({ ...base, reply: reply([['the paper states the dataset size', [1]], ['the paper states the split', []]]) });
    expect(s).toMatchObject({ value: 'unmet', choice: 'b', rule: 'unmet: 1 of 2 conditions stated by a quote' });
    expect(s.cite).toContain('absence');
  });
  it('skips when neither reading matches', () => expect(settle({ ...base, a: 'unmet', b: 'n/a' })).toMatchObject({ choice: 'skip', note: 'neither reading matches evidence value met' }));
  it('B missing: a or skip', () => {
    expect(settle({ ...base, b: null }).choice).toBe('a');
    expect(settle({ ...base, a: 'unmet', b: null }).choice).toBe('skip');
  });
});

describe('settle: points', () => {
  const p = { ...base, points: true, a: 15, b: 10 as number | null };
  it('15 all, 10 some, 5 mentions only, 0 nothing', () => {
    expect(settle(p)).toMatchObject({ value: 15, level: 15, choice: 'a' });
    expect(settle({ ...p, reply: reply([['the paper states the dataset size', [1]], ['the paper states the split', []]]) })).toMatchObject({ value: 10, choice: 'b' });
    const none: [string, number[]][] = [['the paper states the dataset size', []], ['the paper states the split', []]];
    expect(settle({ ...p, a: 5, reply: reply(none, { mentions: ['Q1'] }) })).toMatchObject({ value: 5, choice: 'a' });
    const z = settle({ ...p, a: 0, reply: reply(none, { mentions: [] }) });
    expect(z).toMatchObject({ value: 0, choice: 'a' });
    expect(z.cite).toContain('absence');
  });
});

describe('settle: n/a', () => {
  const na = { ...base, hasNa: true, a: 'unmet' as const, b: 'n/a' as const };
  it('holds -> n/a', () => expect(settle({ ...na, reply: { ...both, na: { state: 'holds', quotes: ['1'] } } })).toMatchObject({ value: 'n/a', choice: 'b' }));
  it('contradicted falls through to the checklist', () => expect(settle({ ...na, reply: { ...both, na: { state: 'contradicted', quotes: ['1'] } } }).value).toBe('met'));
  it('abc O.* silent -> n/a, citing the abc default; non-abc silent is not', () => {
    const silent = { ...both, na: { state: 'silent' as const, quotes: [] } };
    const s = settle({ ...na, standard: 'abc', item: 'O.a.1', reply: silent });
    expect(s).toMatchObject({ value: 'n/a', choice: 'b' });
    expect(s.cite).toContain('abc');
    expect(settle({ ...na, standard: 'abc', item: 'T.1', reply: silent }).value).toBe('met');
    expect(settle({ ...na, reply: silent }).value).toBe('met');
  });
  it('an item with no N/A condition is never n/a', () => expect(settle({ ...base, reply: { ...both, na: { state: 'holds', quotes: [] } } }).value).toBe('met'));
});

describe('settle: code checks', () => {
  it('a condition that is not a span of the rule skips', () =>
    expect(settle({ ...base, reply: reply([['something else entirely', [1]]]) })).toMatchObject({ choice: 'skip', note: expect.stringContaining('not a span') }));
  it('whitespace and case are ignored in the span check', () =>
    expect(settle({ ...base, reply: reply([['THE paper  states\nthe dataset size', [1]]]) }).value).toBe('met'));
  it('unknown quote id, missing reply or no conditions skip', () => {
    expect(settle({ ...base, reply: reply([['the paper states the split', [3]]]) }).choice).toBe('skip');
    expect(settle({ ...base, reply: undefined }).choice).toBe('skip');
    expect(settle({ ...base, reply: reply([]) }).choice).toBe('skip');
  });
});

describe('poolQuotes', () => {
  const ev = (quote: string) => ({ quote, locator: 'p1', url: 'u' });
  const r = (quotes: string[], verified: boolean | null) => ({ value: 'met' as const, rationale: '', evidence: quotes.map(ev), quotes_verified: verified });
  it('pools verified readings, de-duplicates by normalised text, numbers from 1', () => {
    const q = poolQuotes({ a: r(['One  thing', 'Two'], true), b: r(['one thing', 'Three'], null) });
    expect(q.map((x) => [x.id, x.quote])).toEqual([[1, 'One  thing'], [2, 'Two'], [3, 'Three']]);
  });
  it('drops readings whose quotes failed verification', () => expect(poolQuotes({ a: r(['x'], false), b: null })).toEqual([]));
});

describe('citations against the real standards', () => {
  const root = new URL('..', import.meta.url).pathname;
  const lineOf = (cite: string) => readFileSync(`${root}${cite.split(':')[0]}`, 'utf8').split('\n')[Number(cite.split(':')[1]) - 1]!;
  it('abc: the cited line holds that item\'s met: and not_applicable:', () => {
    const c = citations(root, 'abc', 'O.a.1', { cite: ['met', 'na'] });
    expect(c).toHaveLength(1); // flow-style: both on one line, cited once
    expect(lineOf(c[0]!)).toContain('met:');
    expect(lineOf(c[0]!)).toContain('equivalences');
    expect(lineOf(c[0]!)).toContain('not_applicable:');
  });
  it('abc default and absence lines', () => {
    const [d, a] = citations(root, 'abc', 'O.a.1', { cite: ['abc', 'absence'] });
    expect(lineOf(d!)).toContain('n/a unless');
    expect(lineOf(a!)).toContain('Absence of documentation is `unmet`');
  });
  it('every abc item resolves to a met: line', () => {
    const ids = [...readFileSync(`${root}standards/abc.yaml`, 'utf8').matchAll(/- id: (\S+)\s*$/gm)].map((m) => m[1]!);
    for (const id of ids) {
      const l = itemLines(readFileSync(`${root}standards/abc.yaml`, 'utf8'), id);
      if (/^[OTR]\./.test(id) && l.met) expect(lineOf(`standards/abc.yaml:${l.met}`)).toContain('met:');
    }
  });
  it('betterbench has no met: rule; cites the item text line and the level lines', () => {
    const [t] = citations(root, 'betterbench', 'des.01', { cite: ['met'] });
    expect(lineOf(t!)).toContain('text: Tested capability or concept is defined');
    for (const [lv, words] of [[15, 'Fully'], [10, 'Partially'], [5, 'Mentions'], [0, 'Neither']] as const) {
      const [c] = citations(root, 'betterbench', 'des.01', { cite: ['level'], level: lv });
      expect(lineOf(c!)).toContain(words);
    }
    expect(levelLine(readFileSync(`${root}standards/betterbench.yaml`, 'utf8'), 15)).toBe(26);
  });
});
