/**
 * Enforces the audit trail: any change to an assessment's status, mode, published numbers, scores or
 * verdicts must come with a new revision entry naming every changed item or group, and existing
 * revision entries are never edited. Run in CI against the pull request's base.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import type { Assessment } from './schema.ts';

const git = (root: string, args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** True when `<ref>:<path>` exists. A nonzero exit from `cat-file -e` means it does not; a ref that doesn't resolve throws first. */
function existsAt(root: string, ref: string, path: string): boolean {
  git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const r = spawnSync('git', ['cat-file', '-e', `${ref}:${path}`], { cwd: root, encoding: 'utf8' });
  if (r.error) throw r.error;
  return r.status === 0;
}

function changedIds(before: Assessment | undefined, after: Assessment): string[] {
  const out = new Set<string>();
  const differ = (x: unknown, y: unknown) => !isDeepStrictEqual(x, y);
  if (before?.status !== after.status) out.add('status');
  if (before?.mode !== after.mode) out.add('mode');
  if (differ(before?.published, after.published)) out.add('published');
  const bv = before?.verdicts ?? {};
  const av = after.verdicts ?? {};
  for (const id of new Set([...Object.keys(bv), ...Object.keys(av)])) {
    const x = bv[id];
    const y = av[id];
    if (differ(x?.value, y?.value) || differ(x?.evidence ?? [], y?.evidence ?? []) || differ(x?.rationale, y?.rationale)) out.add(id);
  }
  const bs = before?.scores ?? {};
  const as = after.scores ?? {};
  for (const id of new Set([...Object.keys(bs), ...Object.keys(as)])) if (differ(bs[id], as[id])) out.add(id);
  return [...out].sort();
}

export function checkRevisions(root: string, base: string): string[] {
  const errors: string[] = [];
  const entries = git(root, ['diff', '--name-status', '-M', '--diff-filter=AMR', base, '--', 'data/assessments'])
    .split('\n').filter(Boolean).map((line) => line.split('\t'));
  for (const [code, first, second] of entries) {
    // Renames list the old path then the new one; compare the base version of the old with HEAD of the new.
    const oldPath = first!;
    const file = code!.startsWith('R') ? second! : first!;
    if (!file.endsWith('.yaml')) continue;
    const after = parse(git(root, ['show', `HEAD:${file}`])) as Assessment;
    const before = existsAt(root, base, oldPath) ? (parse(git(root, ['show', `${base}:${oldPath}`])) as Assessment) : undefined;

    const prev = before?.revisions ?? [];
    if (prev.some((r, i) => !isDeepStrictEqual(r, after.revisions[i])))
      errors.push(`${file}: existing revision entries were edited or removed; revisions are append-only`);
    const added = after.revisions.slice(prev.length);

    if (!before) {
      if (!added.length) errors.push(`${file}: a new assessment needs at least one revision entry`);
      continue; // a new file's first revision describes the whole assessment
    }
    const changed = changedIds(before, after);
    if (!changed.length) continue;
    if (!added.length) { errors.push(`${file}: changed (${changed.join(', ')}) but no revision entry was added`); continue; }
    // Only a pure model re-run of an automated file, dated to its own run, may skip listing items.
    const automated = file.endsWith('.auto.yaml')
      && added.every((r) => r.by === 'touchstone-assessor' && r.date === after.model_run?.run_on);
    const named = new Set(added.flatMap((r) => r.items ?? []));
    const missing = automated ? [] : changed.filter((id) => !named.has(id));
    if (missing.length) errors.push(`${file}: the new revision entry must list every changed item; missing ${missing.join(', ')}`);
  }
  return errors;
}
