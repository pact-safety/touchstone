import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkRevisions } from '../src/revisions.ts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const git = (root: string, ...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

const doc = (o: { status?: string; value?: string; revisions?: { date: string; summary: string; items?: string[] }[] } = {}) => {
  const revs = o.revisions ?? [{ date: '2026-01-01', summary: 'First assessment.' }];
  return `benchmark: x
standard: y
standard_version: "1"
status: ${o.status ?? 'draft'}
mode: itemized
provenance:
  kind: touchstone
  assessors: [a, b]
  assessed_on: 2026-01-01
verdicts:
  i.01:
    value: ${o.value ?? 'met'}
    rationale: Because the paper says so, in some detail.
    evidence: []
  i.02:
    value: unmet
    rationale: Nothing found in the paper or repo.
    evidence: []
revisions:
${revs.map((r) => `  - date: ${r.date}\n    by: li\n    summary: ${r.summary}${r.items ? `\n    items: [${r.items.join(', ')}]` : ''}`).join('\n')}
`;
};

const FILE = 'data/assessments/x/y.yaml';
let root = '';

const write = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
const commit = (msg: string) => { git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', msg); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'touchstone-rev-'));
  dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  write(FILE, doc());
  commit('base');
});

describe('checkRevisions', () => {
  it('passes when nothing changed', () => {
    write('README.md', 'hi');
    commit('unrelated');
    expect(checkRevisions(root, 'HEAD~1')).toEqual([]);
  });

  it('rejects a verdict change with no new revision', () => {
    write(FILE, doc({ value: 'unmet' }));
    commit('change');
    const errors = checkRevisions(root, 'HEAD~1');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('i.01');
  });

  it('accepts a verdict change whose new revision lists the item', () => {
    const revisions = [
      { date: '2026-01-01', summary: 'First assessment.' },
      { date: '2026-02-01', summary: 'Corrected i.01.', items: ['i.01'] },
    ];
    write(FILE, doc({ value: 'unmet', revisions }));
    commit('change');
    expect(checkRevisions(root, 'HEAD~1')).toEqual([]);
  });

  it('rejects a new revision that does not list the changed item', () => {
    const revisions = [
      { date: '2026-01-01', summary: 'First assessment.' },
      { date: '2026-02-01', summary: 'Corrected something.', items: ['i.02'] },
    ];
    write(FILE, doc({ value: 'unmet', revisions }));
    commit('change');
    expect(checkRevisions(root, 'HEAD~1').join('\n')).toContain('missing i.01');
  });

  it('rejects editing an old revision entry', () => {
    write(FILE, doc({ revisions: [{ date: '2026-01-01', summary: 'Rewritten history.' }] }));
    commit('edit history');
    expect(checkRevisions(root, 'HEAD~1').join('\n')).toContain('existing revision entries');
  });

  it('rejects a rename that changes a verdict without a revision', () => {
    git(root, 'mv', FILE, 'data/assessments/x/z.yaml');
    write('data/assessments/x/z.yaml', doc({ value: 'unmet' }));
    commit('rename and change');
    const errors = checkRevisions(root, 'HEAD~1');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('z.yaml');
    expect(errors[0]).toContain('i.01');
  });

  it('accepts a pure rename', () => {
    git(root, 'mv', FILE, 'data/assessments/x/z.yaml');
    commit('rename');
    expect(checkRevisions(root, 'HEAD~1')).toEqual([]);
  });

  it('rejects a status change without a revision', () => {
    write(FILE, doc({ status: 'published' }));
    commit('publish');
    const errors = checkRevisions(root, 'HEAD~1');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('status');
  });

  it('throws on an unknown base rather than treating files as new', () => {
    expect(() => checkRevisions(root, 'no-such-ref')).toThrow();
  });
});
