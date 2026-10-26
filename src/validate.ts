/**
 * Cross-file rules the schema alone can't express. Every rule here exists so that a score can be
 * traced to item verdicts, and every verdict to evidence someone else can check.
 */
import { dirname, basename } from 'node:path';
import type { Corpus } from './load.ts';
import { fileId } from './load.ts';
import type { Standard } from './schema.ts';

export function validate(c: Corpus): string[] {
  const errors = [...c.errors];
  const standards = new Map(c.standards.map((s) => [s.value.id, s.value]));
  const benchmarks = new Set(c.benchmarks.map((b) => b.value.id));

  for (const { path, value } of c.standards)
    if (fileId(path) !== value.id) errors.push(`${path}: file name must be ${value.id}.yaml`);
  for (const { path, value } of c.benchmarks)
    if (fileId(path) !== value.id) errors.push(`${path}: file name must be ${value.id}.yaml`);

  for (const { path, value: std } of c.standards) {
    if (std.scoring?.scheme !== 'aisl-severity') continue;
    // Categories are ordered best first, so limits may only get looser (never lower) down the list.
    const cats = std.scoring.categories;
    for (const g of std.groups)
      for (let i = 1; i < cats.length; i++)
        for (let j = 0; j < i; j++)
          if ((cats[i]!.max[g.id] ?? 0) < (cats[j]!.max[g.id] ?? 0))
            errors.push(`${path}: category "${cats[i]!.id}" has a lower max for ${g.id} than earlier category "${cats[j]!.id}"; categories must be ordered best first`);
  }

  const allowed = new Set(c.models.map((m) => m.id));

  for (const { path, value: a } of c.assessments) {
    const at = (msg: string) => errors.push(`${path}: ${msg}`);
    // Model-proposed assessments live beside published ones and never overwrite them.
    const expected = a.provenance.kind === 'automated' ? `${a.standard}.auto` : a.standard;
    if (basename(dirname(path)) !== a.benchmark || fileId(path) !== expected)
      at(`must live at data/assessments/${a.benchmark}/${expected}.yaml`);
    if (!benchmarks.has(a.benchmark)) at(`unknown benchmark "${a.benchmark}"`);
    const std = standards.get(a.standard);
    if (!std) { at(`unknown standard "${a.standard}"`); continue; }
    if (std.status !== 'encoded') { at(`standard "${a.standard}" is catalogued only and cannot be scored yet`); continue; }
    if (a.standard_version !== std.version) at(`standard_version ${a.standard_version} does not match ${std.id} version ${std.version}`);

    const dates = a.revisions.map((r) => r.date);
    if (dates.some((d, i) => i > 0 && d < dates[i - 1]!)) at('revisions must be in date order, oldest first');

    if (a.model_run && !allowed.has(a.model_run.model))
      at(`model "${a.model_run.model}" is not on the open-weights allowlist in config/models.yaml`);

    if (a.mode === 'imported') {
      const groups = new Set(std.groups.map((g) => g.id));
      for (const k of Object.keys(a.scores ?? {})) if (!groups.has(k)) at(`scores: unknown group "${k}"`);
      const inRange = (v: unknown): boolean => {
        if (typeof v !== 'number') return true; // 'invalid' and null are not numbers
        const sc = std.scoring!;
        if (sc.scheme === 'aisl-severity') return Number.isInteger(v) && v >= 1 && v <= 4;
        if (sc.scheme === 'points') return v >= 0 && v <= sc.max;
        return v >= 0 && v <= 100;
      };
      for (const [k, v] of Object.entries(a.scores ?? {})) if (!inRange(v)) at(`scores.${k}: ${v} is out of range for the ${std.scoring!.scheme} scheme`);
      for (const [k, v] of Object.entries(a.published?.groups ?? {})) if (!inRange(v)) at(`published.groups.${k}: ${v} is out of range for the ${std.scoring!.scheme} scheme`);
      continue;
    }
    checkVerdicts(std, a, at);
  }
  return errors;
}

function checkVerdicts(std: Standard, a: import('./schema.ts').Assessment, at: (m: string) => void) {
  const items = new Map(std.groups.flatMap((g) => g.items).map((i) => [i.id, i]));
  const verdicts = a.verdicts ?? {};
  const scheme = std.scoring!.scheme;
  const strict = a.provenance.kind !== 'external';

  for (const [id, v] of Object.entries(verdicts)) {
    const item = items.get(id);
    if (!item) { at(`verdicts: unknown item "${id}" in ${std.id}`); continue; }
    if (scheme === 'points') {
      const levels = std.scoring!.scheme === 'points' ? std.scoring!.levels : [];
      if (v.value !== 'n/a' && (typeof v.value !== 'number' || !levels.includes(v.value)))
        at(`verdicts.${id}: must be one of ${levels.join(', ')} or "n/a"`);
    } else if (typeof v.value === 'number') at(`verdicts.${id}: must be met, unmet or n/a`);

    if (!strict) continue;
    if (v.value === 'n/a') {
      if (!item.guidance?.not_applicable) at(`verdicts.${id}: this item has no n/a condition, so it cannot be n/a`);
      if (!v.rationale) at(`verdicts.${id}: n/a needs a rationale naming the n/a condition`);
    } else if (a.status === 'published') {
      // A positive verdict must point at evidence. A negative one records an absence, which can't be
      // quoted, so it needs a rationale saying what was looked for instead.
      const positive = v.value === 'met' || (typeof v.value === 'number' && v.value > 0);
      if (positive && v.evidence.length === 0) at(`verdicts.${id}: a positive verdict needs at least one evidence entry`);
      if (!positive && v.evidence.length === 0 && !v.rationale) at(`verdicts.${id}: a negative verdict needs evidence or a rationale`);
    }
    if (a.provenance.kind === 'automated' && v.by === 'model' && v.evidence.some((e) => e.quote) && v.quotes_verified !== true)
      at(`verdicts.${id}: model verdict quotes were not verified against the source`);
  }

  if (a.status === 'published') {
    const missing = [...items.keys()].filter((id) => !(id in verdicts));
    if (missing.length) at(`published itemized assessments need every item; missing ${missing.join(', ')}`);
    if (a.provenance.kind === 'touchstone' && a.provenance.assessors.length < 2)
      at('published Touchstone assessments need two independent assessors');
  }
}
