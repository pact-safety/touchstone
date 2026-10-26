/**
 * Enforces the audit trail: any change to an assessment's verdicts or scores must come with a new
 * revision entry naming every changed item or group. Run in CI against the pull request's base.
 */
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import type { Assessment } from './schema.ts';

const git = (root: string, args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

function changedIds(before: Assessment | undefined, after: Assessment): string[] {
  const out = new Set<string>();
  const bv = before?.verdicts ?? {};
  const av = after.verdicts ?? {};
  for (const id of new Set([...Object.keys(bv), ...Object.keys(av)])) {
    const x = bv[id];
    const y = av[id];
    if (JSON.stringify(x?.value) !== JSON.stringify(y?.value) || JSON.stringify(x?.evidence ?? []) !== JSON.stringify(y?.evidence ?? [])) out.add(id);
  }
  const bs = before?.scores ?? {};
  const as = after.scores ?? {};
  for (const id of new Set([...Object.keys(bs), ...Object.keys(as)])) if (bs[id] !== as[id]) out.add(id);
  return [...out].sort();
}

export function checkRevisions(root: string, base: string): string[] {
  const errors: string[] = [];
  const files = git(root, ['diff', '--name-only', '--diff-filter=AM', base, '--', 'data/assessments'])
    .split('\n').filter((f) => f.endsWith('.yaml'));
  for (const file of files) {
    const after = parse(git(root, ['show', `HEAD:${file}`])) as Assessment;
    let before: Assessment | undefined;
    try { before = parse(git(root, ['show', `${base}:${file}`])) as Assessment; } catch { before = undefined; }
    const changed = changedIds(before, after);
    if (!changed.length) continue;
    const prevCount = before?.revisions.length ?? 0;
    const added = after.revisions.slice(prevCount);
    if (!added.length) { errors.push(`${file}: verdicts changed (${changed.join(', ')}) but no revision entry was added`); continue; }
    if (!before) continue; // a new file's first revision describes the whole assessment
    const named = new Set(added.flatMap((r) => r.items ?? []));
    const automated = added.every((r) => r.by === 'touchstone-assessor');
    const missing = automated ? [] : changed.filter((id) => !named.has(id));
    if (missing.length) errors.push(`${file}: the new revision entry must list every changed item; missing ${missing.join(', ')}`);
  }
  return errors;
}
