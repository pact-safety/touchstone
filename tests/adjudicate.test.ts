import { describe, expect, it } from 'vitest';
import { citations, itemLines, levelLine, poolQuotes, settle, type Quote, type Reply, type SettleIn } from '../scripts/adjudicate.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

const MET = 'The paper states the dataset size and the paper states the split.';
const QUOTES: Quote[] = ['The dataset has 500 items in total.', 'We split it 80/20 into train and test.', 'Unrelated sentence.'].map((quote, k) => ({ id: k + 1, quote, locator: 'p1', url: 'u' }));
const span = (n: number) => QUOTES[n - 1]?.quote ?? 'x';
/** One requirement per entry; each entry lists its alternatives as [condition, quote ids]. Spans are the whole quote. */
const reqs = (...rs: [string, number[]][][]): Reply['requirements'] =>
  rs.map((alts) => ({ alternatives: alts.map(([condition, q]) => ({ condition, quotes: q.map((n) => ({ id: String(n), span: span(n) })), reason: 'r' })) }));
const reply = (conds: [string, number[]][], extra: Partial<Reply> = {}): Reply => ({ item: 'i', requirements: reqs(...conds.map((c) => [c])), ...extra });
const both = reply([['the paper states the dataset size', [1]], ['the paper states the split', [2]]]);
const base: SettleIn = { standard: 's', item: 'i', met: MET, hasNa: false, points: false, quotes: QUOTES, a: 'met', b: 'unmet', reply: both, reply2: both };
/** Same reply from both judges. */
const same = (r: Reply | undefined): Partial<SettleIn> => ({ reply: r, reply2: r });

describe('settle: checklist', () => {
  it('met when every requirement has a quote, and picks the matching reading', () => {
    expect(settle(base)).toMatchObject({ value: 'met', choice: 'a', rule: 'met: 2 of 2 requirements stated by a quote both judges credit' });
    expect(settle({ ...base, a: 'unmet', b: 'met' })).toMatchObject({ value: 'met', choice: 'b' });
  });
  it('unmet when a requirement has none, citing absence', () => {
    const s = settle({ ...base, ...same(reply([['the paper states the dataset size', [1]], ['the paper states the split', []]])) });
    expect(s).toMatchObject({ value: 'unmet', choice: 'b', rule: 'unmet: 1 of 2 requirements stated by a quote both judges credit' });
    expect(s.cite).toContain('absence');
  });
  it('skips when neither reading matches', () => expect(settle({ ...base, a: 'unmet', b: 'n/a' })).toMatchObject({ choice: 'skip', note: 'neither reading matches evidence value met' }));
  it('B missing: a or skip', () => {
    expect(settle({ ...base, b: null }).choice).toBe('a');
    expect(settle({ ...base, a: 'unmet', b: null }).choice).toBe('skip');
  });
});

describe('settle: alternatives (OR rule)', () => {
  const met = 'Labels are double-checked or the benchmark has no labels.';
  const or = (q1: number[], q2: number[]): Reply => ({ item: 'i', requirements: reqs([['Labels are double-checked', q1], ['the benchmark has no labels', q2]]) });
  it('met with one branch', () => {
    expect(settle({ ...base, met, ...same(or([], [3])) })).toMatchObject({ value: 'met', choice: 'a' });
    expect(settle({ ...base, met, ...same(or([1], [])) }).value).toBe('met');
  });
  it('unmet with neither branch; another requirement is still ANDed', () => {
    expect(settle({ ...base, met, ...same(or([], [])) }).value).toBe('unmet');
    const r: Reply = { item: 'i', requirements: reqs([['Labels are double-checked', [1]], ['the benchmark has no labels', []]], [['Labels are double-checked', []]]) };
    expect(settle({ ...base, met, ...same(r) }).value).toBe('unmet');
  });
});

describe('settle: alternatives need the rule\'s own "or"', () => {
  it('skips when the judge invents alternatives', () =>
    expect(settle({ ...base, ...same({ item: 'i', requirements: reqs([['the paper states the dataset size', [1]], ['the paper states the split', [2]]]) }) })).toMatchObject({ choice: 'skip', note: expect.stringContaining('no "or"') }));
});

describe('settle: verbatim span and two judges', () => {
  const withSpan = (sp: string): Reply => ({ item: 'i', requirements: [{ alternatives: [{ condition: 'the paper states the split', quotes: [{ id: '2', span: sp }], reason: 'r' }] }] });
  it('a span copied from the quote is credited, ignoring case and spacing', () =>
    expect(settle({ ...base, ...same(withSpan('split it  80/20 INTO train')) }).value).toBe('met'));
  it('an unverified span is not credited (unmet, not skipped)', () => {
    const s = settle({ ...base, ...same(withSpan('we split it 90/10')) });
    expect(s).toMatchObject({ value: 'unmet', choice: 'b' });
    expect(s.alts![0]).toMatchObject({ stated: false, judges: { a: [], b: [] } });
  });
  it('a span of more than 30 words is not credited', () => {
    const long = Array.from({ length: 31 }, (_, k) => `w${k}`).join(' ');
    const quotes = [{ ...QUOTES[0]!, quote: long }, QUOTES[1]!, QUOTES[2]!];
    const r: Reply = { item: 'i', requirements: [{ alternatives: [{ condition: 'the paper states the split', quotes: [{ id: '1', span: long }], reason: 'r' }] }] };
    expect(settle({ ...base, quotes, ...same(r) }).value).toBe('unmet');
  });
  it('credit from only one judge does not state the condition', () => {
    const none = reply([['the paper states the dataset size', []], ['the paper states the split', []]]);
    const s = settle({ ...base, reply: both, reply2: none });
    expect(s.value).toBe('unmet');
    expect(s.alts![0]).toMatchObject({ stated: false, judges: { a: [1], b: [] } });
    expect(settle({ ...base, reply: none, reply2: both }).value).toBe('unmet');
  });
  it('the judges may credit different quotes', () => {
    const r2 = reply([['the paper states the dataset size', [3]], ['the paper states the split', [2]]]);
    expect(settle({ ...base, reply2: r2 })).toMatchObject({ value: 'met', alts: [{ judges: { a: [1], b: [3] }, stated: true }, { stated: true }] });
  });
  it('a condition judge 2 drops gets no credit', () =>
    expect(settle({ ...base, reply2: reply([['the paper states the split', [2]]]) })).toMatchObject({ value: 'unmet', alts: [{ stated: false }, { stated: true }] }));
  it('points: mentions is the intersection of the judges', () => {
    const none: [string, number[]][] = [['the paper states the dataset size', []], ['the paper states the split', []]];
    const p = { ...base, points: true, a: 5, b: 0 as number | null };
    expect(settle({ ...p, reply: reply(none, { mentions: ['Q1'] }), reply2: reply(none, { mentions: ['Q1', 'Q2'] }) })).toMatchObject({ value: 5, choice: 'a' });
    expect(settle({ ...p, reply: reply(none, { mentions: ['Q1'] }), reply2: reply(none, { mentions: ['Q2'] }) })).toMatchObject({ value: 0, choice: 'b' });
  });
});

describe('settle: points', () => {
  const p = { ...base, points: true, a: 15, b: 0 as number | null };
  it('15 all, 10 some, 5 mentions only, 0 nothing', () => {
    expect(settle(p)).toMatchObject({ value: 15, level: 15, choice: 'a' });
    expect(settle({ ...p, a: 0, b: 10, ...same(reply([['the paper states the dataset size', [1]], ['the paper states the split', []]])) })).toMatchObject({ value: 10, choice: 'b' });
    const none: [string, number[]][] = [['the paper states the dataset size', []], ['the paper states the split', []]];
    expect(settle({ ...p, a: 5, b: 0, ...same(reply(none, { mentions: ['Q1'] })) })).toMatchObject({ value: 5, choice: 'a' });
    const z = settle({ ...p, a: 0, ...same(reply(none, { mentions: [] })) });
    expect(z).toMatchObject({ value: 0, choice: 'a' });
    expect(z.cite).toContain('absence');
  });
});

describe('settle: two positive BetterBench levels', () => {
  const p = { ...base, points: true, a: 15, b: 10 as number | null };
  it('skips with the fixed note but still records V and the level cite', () => {
    const s = settle(p);
    expect(s).toMatchObject({ choice: 'skip', value: 15, level: 15, note: expect.stringContaining('cannot choose between two positive levels') });
    expect(s.cite).toContain('level');
  });
  it('a positive level against 0 is still decided', () => expect(settle({ ...p, b: 0 }).choice).toBe('a'));
});

describe('settle: n/a', () => {
  const na = { ...base, hasNa: true, a: 'unmet' as const, b: 'n/a' as const };
  const withNa = (state: 'holds' | 'contradicted' | 'silent') => ({ ...both, na: { state, quotes: ['1'] } });
  it('holds -> n/a', () => expect(settle({ ...na, ...same(withNa('holds')) })).toMatchObject({ value: 'n/a', choice: 'b' }));
  it('holds needs both judges', () => {
    expect(settle({ ...na, reply: withNa('holds'), reply2: withNa('silent') }).value).toBe('met');
    expect(settle({ ...na, reply: withNa('silent'), reply2: withNa('holds') }).value).toBe('met');
    expect(settle({ ...na, reply: withNa('holds'), reply2: withNa('contradicted') }).value).toBe('met');
  });
  it('a missing na on an item with an N/A condition skips', () => expect(settle({ ...na, ...same(both) })).toMatchObject({ choice: 'skip', note: expect.stringContaining('N/A') }));
  it('contradicted falls through to the checklist', () => expect(settle({ ...na, ...same(withNa('contradicted')) }).value).toBe('met'));
  it('abc O.* silent -> n/a, citing the abc default; non-abc silent is not', () => {
    const silent = withNa('silent');
    const s = settle({ ...na, standard: 'abc', item: 'O.a.1', ...same(silent) });
    expect(s).toMatchObject({ value: 'n/a', choice: 'b' });
    expect(s.cite).toContain('abc');
    expect(settle({ ...na, standard: 'abc', item: 'T.1', ...same(silent) }).value).toBe('met');
    expect(settle({ ...na, ...same(silent) }).value).toBe('met');
  });
  it('an item with no N/A condition is never n/a', () => expect(settle({ ...base, ...same({ ...both, na: { state: 'holds', quotes: [] } }) }).value).toBe('met'));
});

describe('settle: code checks', () => {
  it('a condition that is not a span of the rule skips', () =>
    expect(settle({ ...base, ...same(reply([['something else entirely', [1]]])) })).toMatchObject({ choice: 'skip', note: expect.stringContaining('not a span') }));
  it('whitespace and case are ignored in the span check', () =>
    expect(settle({ ...base, ...same(reply([['THE paper  states\nthe dataset size', [1]]])) }).value).toBe('met'));
  it('trailing punctuation and typographic quotes do not break the span check', () => {
    const met = 'The “paper” states the dataset’s size.';
    expect(settle({ ...base, met, ...same(reply([['the "paper" states the dataset\'s size', [1]]])) }).value).toBe('met');
    expect(settle({ ...base, met: 'One thing; and another.', ...same(reply([['One thing', [1]], ['and another', [2]]])) }).value).toBe('met');
  });
  it('accepts Q2, q2, 2 and 2 as the same quote id', () => {
    for (const id of ['Q2', 'q2', '2', 2]) {
      const r: Reply = { item: 'i', requirements: [{ alternatives: [{ condition: 'the paper states the split', quotes: [{ id, span: span(2) }], reason: 'r' }] }] };
      expect(settle({ ...base, ...same(r) }).value).toBe('met');
    }
    const bad: Reply = { item: 'i', requirements: [{ alternatives: [{ condition: 'the paper states the split', quotes: [{ id: 'Q9', span: 'x' }], reason: 'r' }] }] };
    expect(settle({ ...base, ...same(bad) }).choice).toBe('skip');
  });
  it('unknown quote id, missing reply or no requirements skip', () => {
    expect(settle({ ...base, ...same(reply([['the paper states the split', [9]]])) }).choice).toBe('skip');
    expect(settle({ ...base, reply: undefined }).choice).toBe('skip');
    expect(settle({ ...base, reply2: undefined }).choice).toBe('skip');
    expect(settle({ ...base, ...same(reply([])) }).choice).toBe('skip');
  });
});

describe('settle: no judge call (no verified quote)', () => {
  const whole = reply([[MET, []]], { mentions: [] });
  const none = { ...base, quotes: [], noCall: true, ...same(whole) };
  it('checklist: unmet, says so', () =>
    expect(settle({ ...none, a: 'unmet', b: null })).toMatchObject({ value: 'unmet', choice: 'a', rule: expect.stringContaining('without a judge call') }));
  it('points: 0', () => expect(settle({ ...none, points: true, a: 0, b: 15 })).toMatchObject({ value: 0, choice: 'a' }));
  it('abc O.* with an N/A condition: n/a', () =>
    expect(settle({ ...none, standard: 'abc', item: 'O.b.1', hasNa: true, a: 'unmet', b: 'n/a', ...same({ ...whole, na: { state: 'silent', quotes: [] } }) })).toMatchObject({ value: 'n/a', choice: 'b' }));
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

describe('itemLines: flow-style items', () => {
  const yaml = [
    '    items:',
    '      - { id: 1.2.1, text: "T1", guidance: { met: "M1", not_applicable: "N1" } }',
    '      - { id: "1.2.1a", text: "T2", guidance: { met: "M2" } }',
    '      - id: B.1',
    '        text: T3',
    '        guidance:',
    '          met: M3',
  ].join('\n');
  it('returns the start line for met, na and text', () => expect(itemLines(yaml, '1.2.1')).toEqual({ met: 2, na: 2, text: 2 }));
  it('1.2.1 vs 1.2.1a resolves to its own line', () => {
    expect(itemLines(yaml, '1.2.1a')).toEqual({ met: 3, text: 3 });
    expect(itemLines(yaml, '1.2')).toEqual({});
  });
  it('block style still works after flow items', () => expect(itemLines(yaml, 'B.1')).toEqual({ met: 7, text: 5 }));
  it('every item in standards/*.yaml resolves to a met: or text: line', () => {
    const root = new URL('..', import.meta.url).pathname;
    let n = 0;
    for (const f of readdirSync(`${root}standards`).filter((x) => x.endsWith('.yaml'))) {
      const src = readFileSync(`${root}standards/${f}`, 'utf8');
      const doc = parse(src) as { groups?: { items?: { id: string | number }[] }[] };
      for (const it of (doc.groups ?? []).flatMap((g) => g.items ?? [])) {
        const l = itemLines(src, String(it.id));
        expect(l.met ?? l.text, `${f} ${it.id}`).toBeDefined();
        n++;
      }
    }
    expect(n).toBeGreaterThan(100);
  });
});
