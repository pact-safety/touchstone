import { describe, expect, it } from 'vitest';
import { githubRepos, noteToVerdict } from '../scripts/notes-to-verdicts.ts';
import { applyPair } from '../scripts/apply-review.ts';

const SHA = 'a'.repeat(40);
const pin = (repo: string) => (repo === 'o/r' ? SHA : undefined);
const arxiv = 'https://arxiv.org/html/2311.12983v1';
const conv = (note: string | undefined) => noteToVerdict(note, pin) as any;

describe('noteToVerdict values', () => {
  it.each([
    ['Met — §3.1 grounds it. ' + arxiv, 'met', '§3.1 grounds it.'],
    ['Unmet — nothing found.', 'unmet', 'nothing found.'],
    ['N/A — not normative.', 'n/a', 'not normative.'],
    ['NA: not normative.', 'n/a', 'not normative.'],
    ['15 — fine. ' + arxiv, 15, 'fine.'],
    ['10: partial. ' + arxiv, 10, 'partial.'],
    ['Score 5 based on the paper. ' + arxiv, 5, 'based on the paper.'],
  ])('%s', (note, value, rationale) => {
    const r = conv(note);
    expect(r.verdict).toMatchObject({ value, rationale, by: 'human' });
    expect(r.verdict).not.toHaveProperty('quotes_verified');
  });
  it('rejects empty and valueless notes', () => {
    expect(conv('')).toEqual({ reason: 'no note' });
    expect(conv(undefined)).toEqual({ reason: 'no note' });
    expect(conv('Metrics are fine')).toEqual({ reason: 'no clear value' });
    expect(conv('See the paper')).toEqual({ reason: 'no clear value' });
  });
});

describe('noteToVerdict evidence', () => {
  it('converts arXiv html to abs, source paper, with the first locator', () => {
    const r = conv(`Met — see Table 2 and §4. ${arxiv}.`);
    expect(r.verdict.evidence).toEqual([{ source: 'paper', url: 'https://arxiv.org/abs/2311.12983v1', locator: 'Table 2' }]);
  });
  it('defaults the locator', () => expect(conv(`Met ${arxiv}`).verdict.evidence[0].locator).toBe('reviewer note'));
  it('pins GitHub repo roots and branch blobs/trees, keeps SHA urls', () => {
    const r = conv('Met — code. https://github.com/o/r, https://github.com/o/r/blob/master/a/b.py; https://github.com/o/r/tree/main/docs) https://github.com/o/r/blob/' + SHA + '/x.py');
    expect(r.verdict.evidence.map((e: any) => [e.source, e.url])).toEqual([
      ['repo', `https://github.com/o/r/tree/${SHA}`],
      ['repo', `https://github.com/o/r/blob/${SHA}/a/b.py`],
      ['repo', `https://github.com/o/r/tree/${SHA}/docs`],
      ['repo', `https://github.com/o/r/blob/${SHA}/x.py`],
    ]);
    expect(r.verdict.rationale).toBe('code.');
  });
  it('lists GitHub repos for pre-resolution', () => expect(githubRepos('x https://github.com/o/r/blob/main/a.py, y')).toEqual(['o/r']));
  it('drops mutable and unpinnable urls', () => {
    const r = conv('Unmet — absent. https://aclanthology.org/2022.acl-long.229/ https://github.com/x/y');
    expect(r.verdict.evidence).toEqual([]);
  });
  it('rejects a positive verdict without immutable evidence', () => {
    expect(conv('15 — Published. https://aclanthology.org/2022.acl-long.229/')).toEqual({ reason: 'positive verdict without fixed-version evidence' });
    expect(conv('Met — claimed.')).toEqual({ reason: 'positive verdict without fixed-version evidence' });
  });
  it('accepts a negative or zero verdict with a rationale and no evidence', () => expect(conv('0 — absent').verdict).toMatchObject({ value: 0, evidence: [] }));
});

describe('apply-review with note verdicts', () => {
  const v = (value: string) => ({ value, rationale: 'r', evidence: [], by: 'model' });
  const doc = () => ({
    benchmark: 'b', standard: 's', status: 'draft', provenance: { kind: 'automated', assessors: ['m'] },
    verdicts: { i1: v('met'), i2: v('met') }, revisions: [{ date: '2026-10-29', by: 'm', summary: 's' }],
  });
  const pair = { id: 'b~s', benchmark: 'b', standard: 's', items: 2, agreed: 1, to_review: 1 };
  const rows = [{ item: 'i2' }] as any;
  const nv = { i2: { value: 'unmet', rationale: 'Li says', evidence: [], by: 'human' } };
  it('publishes an approved pair whose other row has a note verdict', () => {
    const r = applyPair(doc(), pair, rows, { i2: 'other' }, undefined, true, '2026-11-11', () => undefined, nv);
    expect(r.published).toBe(true);
    expect(r.doc.verdicts.i2).toEqual(nv.i2);
    expect(r.doc.revisions.at(-1)).toMatchObject({ by: 'Li Bearden', items: ['status', 'i2'] });
    expect(r.doc.revisions.at(-1).summary).toContain('1 decided by the reviewer');
  });
  it('without a note verdict the pair stays draft and the row untouched', () => {
    const r = applyPair(doc(), pair, rows, { i2: 'other' }, undefined, true, '2026-11-11');
    expect(r.published).toBe(false);
    expect(r.doc.verdicts.i2).toEqual(v('met'));
  });
});
