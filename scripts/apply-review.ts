/**
 * Apply a person's cross-check decisions to data/assessments/<b>/<s>.auto.yaml.
 *   npx tsx scripts/apply-review.ts --rows <rows.json> --b-root <dir> --decisions <file> --approvals <file> [--dry-run]
 * decisions: one doc per pair { id: "<b>~<s>", data: { choices: { <item>: "a" | "b" | "skip" } } }.
 * approvals: one doc per standard { id: "<s>", data: { approved: true } }.
 * a: keep A's verdict, by human. b: copy B's verdict from --b-root, by human. skip/none: untouched.
 * An approved standard's pairs with every review row decided become published, reviewed by REVIEWER.
 * A pair whose result would not pass validation is left as it was and listed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse, stringify } from 'yaml';
import { load, type Corpus } from '../src/load.ts';
import { validate } from '../src/validate.ts';
import { Assessment } from '../src/schema.ts';
import { MODEL_B, type Rows } from './crosscheck.ts';

export const REVIEWER = 'Li Bearden';
type Doc = Record<string, any>;
type Choice = 'a' | 'b' | 'skip';

/** The tool's list output: a bare array, or wrapped in `documents`/`items`; empty text means none. Docs may carry their fields in `data`. */
export function readDocs(text: string): { id: string; data: Doc }[] {
  if (!text.trim()) return [];
  const j = JSON.parse(text);
  const list: Doc[] = Array.isArray(j) ? j : (j.documents ?? j.items ?? []);
  return list.map((d) => ({ id: String(d.id), data: (d.data ?? d) as Doc }));
}

export interface PairResult { pair: string; doc: Doc; changed: string[]; published: boolean; note?: string }

/** Applies one pair's choices (and the publish step when its standard is approved) to a parsed A file. */
export function applyPair(
  doc: Doc, pair: Rows['pairs'][number], reviewRows: Rows['rows'], choices: Record<string, Choice>, bDoc: Doc | undefined,
  approved: boolean, date: string,
): PairResult {
  const out = structuredClone(doc);
  const changed: string[] = [];
  let undecided = 0;
  for (const r of reviewRows) {
    const c = choices[r.item];
    const bv = bDoc?.verdicts?.[r.item];
    if (c === 'a') { out.verdicts[r.item].by = 'human'; changed.push(`${r.item}:a`); }
    else if (c === 'b' && bv) {
      const { value, rationale, evidence, quotes_verified } = bv;
      const mine = out.verdicts[r.item];
      for (const k of ['rationale', 'evidence', 'quotes_verified']) delete mine[k];
      Object.assign(mine, { value, rationale, evidence, by: 'human', quotes_verified });
      changed.push(`${r.item}:b`);
    } else undecided++;
  }
  let published = false;
  let note: string | undefined;
  if (approved && out.status === 'draft') {
    if (undecided) note = `${undecided} review row(s) skipped or undecided`;
    else {
      const decided = reviewRows.length;
      out.status = 'published';
      out.provenance.reviewers = [...new Set([...(out.provenance.reviewers ?? []), REVIEWER])];
      out.revisions.push({
        date, by: REVIEWER,
        summary: `Reviewed against a ${MODEL_B} cross-check: ${pair.agreed} verdicts agreed, ${decided} decided by the reviewer.`,
      });
      published = true;
    }
  }
  return { pair: pair.id, doc: out, changed, published, note };
}

/** Header comment lines (kept as-is) and the parsed body of an assessment file. */
const split = (text: string) => ({ header: text.match(/^(#.*\n)*/)![0], doc: parse(text) as Doc });
const render = (header: string, doc: Doc) => header + stringify(doc, { lineWidth: 0 });

const errorsFor = (c: Corpus, doc: Doc): string[] => {
  const p = Assessment.safeParse(doc);
  if (!p.success) return p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  const path = `data/assessments/${doc.benchmark}/${doc.standard}.auto.yaml`;
  return validate({ ...c, assessments: [{ path, value: p.data }] });
};

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values } = parseArgs({
    options: { rows: { type: 'string' }, 'b-root': { type: 'string' }, decisions: { type: 'string' }, approvals: { type: 'string' }, 'dry-run': { type: 'boolean' } },
  });
  if (!values.rows || !values['b-root'] || !values.decisions || !values.approvals) {
    console.error('usage: apply-review.ts --rows <rows.json> --b-root <dir> --decisions <file> --approvals <file> [--dry-run]');
    process.exit(1);
  }
  const root = new URL('..', import.meta.url).pathname;
  const rows: Rows = JSON.parse(readFileSync(values.rows, 'utf8'));
  const decisions = new Map(readDocs(readFileSync(values.decisions, 'utf8')).map((d) => [d.id, (d.data.choices ?? {}) as Record<string, Choice>]));
  const approved = new Set(readDocs(readFileSync(values.approvals, 'utf8')).filter((d) => d.data.approved === true).map((d) => d.id));
  const c = load(root);
  const date = new Date().toISOString().slice(0, 10);
  let touched = 0;
  const log = (s: string) => console.log(s);
  for (const pair of rows.pairs) {
    const choices = decisions.get(pair.id) ?? {};
    const isApproved = approved.has(pair.standard);
    if (!Object.keys(choices).length && !isApproved) continue;
    const rel = `data/assessments/${pair.benchmark}/${pair.standard}.auto.yaml`;
    const { header, doc } = split(readFileSync(join(root, rel), 'utf8'));
    if (doc.status === 'published') { log(`${pair.id}: already published, left alone`); continue; }
    let bDoc: Doc | undefined;
    try { bDoc = split(readFileSync(join(resolve(values['b-root']), rel), 'utf8')).doc; } catch { /* B file absent */ }
    const r = applyPair(doc, pair, rows.rows.filter((x) => x.pair === pair.id), choices, bDoc, isApproved, date);
    if (!r.changed.length && !r.published) { if (r.note) log(`${pair.id}: stays draft (${r.note})`); continue; }
    let errs = errorsFor(c, r.doc);
    if (errs.length && r.published) {
      // Publishing is what failed validation: keep the decisions, leave the pair as a draft.
      const draft = applyPair(doc, pair, rows.rows.filter((x) => x.pair === pair.id), choices, bDoc, false, date);
      const draftErrs = errorsFor(c, draft.doc);
      if (!draftErrs.length) { Object.assign(r, draft, { note: `would not validate when published: ${errs[0]}` }); errs = []; }
    }
    if (errs.length) { log(`${pair.id}: NOT APPLIED, would not validate: ${errs[0]}`); continue; }
    touched++;
    log(`${pair.id}: ${r.changed.join(' ') || 'no verdict changes'}${r.published ? ' -> published' : ''}${r.note ? ` (stays draft: ${r.note})` : ''}`);
    if (!values['dry-run']) writeFileSync(join(root, rel), render(header, r.doc));
  }
  log(touched ? `${values['dry-run'] ? 'would change' : 'changed'} ${touched} file(s)` : 'nothing to do');
}
