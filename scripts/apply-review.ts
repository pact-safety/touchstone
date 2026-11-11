/**
 * Apply a person's cross-check decisions to data/assessments/<b>/<s>.auto.yaml.
 *   npx tsx scripts/apply-review.ts --rows <rows.json> --decisions <file> --approvals <file> --adjudication <adjudication.json> [--b-root <dir>] [--note-verdicts <file>] [--dry-run]
 * decisions: one doc per pair { id: "<b>~<s>", data: { choices: { <item>: "a" | "b" | "skip" | "other" }, notes?: { <item>: string } } }.
 * approvals: one doc per standard { id: "<s>", data: { approved: true } }.
 * a: keep A's verdict. b: copy B's verdict from --b-root, or from rows.json where B's file is absent. skip/none: untouched.
 * other: neither reading is right or something is missing; untouched like skip, and listed with the reviewer's note to fix by hand.
 *   With --note-verdicts <file> ({ "<pair>": { "<item>": Verdict } }, from notes-to-verdicts.ts) an other row with an entry
 *   takes that verdict (by: human) and counts as decided; other rows without one behave as above.
 * A choice the adjudicator made stays by: model with adjudicated_by; any other choice is a person's, by: human.
 * An approved standard's pairs with every review row decided become published, reviewed by REVIEWER;
 * the revision says how many rows the adjudicator settled and how many the reviewer decided.
 * A pair whose result would not pass validation is left as it was and listed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { parse, stringify } from 'yaml';
import { load, type Corpus } from '../src/load.ts';
import { validate } from '../src/validate.ts';
import { Assessment } from '../src/schema.ts';
import { MODEL_B, type Row, type Rows } from './crosscheck.ts';

export const REVIEWER = 'Li Bearden';
type Doc = Record<string, any>;
type Choice = 'a' | 'b' | 'skip' | 'other';

/** The tool's list output: a bare array, or wrapped in `documents`/`items`; empty text means none. Docs may carry their fields in `data`. */
export function readDocs(text: string): { id: string; data: Doc }[] {
  if (!text.trim()) return [];
  const j = JSON.parse(text);
  const list: Doc[] = Array.isArray(j) ? j : (j.documents ?? j.items ?? []);
  return list.map((d) => ({ id: String(d.id), data: (d.data ?? d) as Doc }));
}

/** Each URL's source kind from one benchmark's assessments; a URL recorded under two kinds is left out. */
export function evidenceSources(assessments: { value: { benchmark: string; verdicts?: Record<string, { evidence?: { url: string; source: string }[] }> } }[], benchmark: string): Map<string, string> {
  const kinds = new Map<string, Set<string>>();
  for (const { value: a } of assessments) {
    if (a.benchmark !== benchmark) continue;
    for (const v of Object.values(a.verdicts ?? {})) for (const e of v.evidence ?? []) kinds.set(e.url, (kinds.get(e.url) ?? new Set()).add(e.source));
  }
  return new Map([...kinds].filter(([, k]) => k.size === 1).map(([url, k]) => [url, [...k][0]!]));
}

/** B's verdicts rebuilt from review rows, which omit each quote's source. A row with a source that can't be resolved is left out, so a b choice on it stays undecided. */
export function readingsFromRows(rows: Pick<Row, 'item' | 'b'>[], sources: Map<string, string>): Doc {
  const verdicts: Doc = {};
  for (const { item, b } of rows) {
    if (!b || !b.evidence.every((e) => sources.has(e.url))) continue;
    verdicts[item] = { ...b, evidence: b.evidence.map((e) => ({ source: sources.get(e.url), ...e })) };
  }
  return { verdicts };
}

/** Who made each choice: the adjudicator's name when it made this one, else undefined for a person. */
export type SettledBy = (item: string, choice: Choice) => string | undefined;

export interface PairResult { pair: string; doc: Doc; changed: string[]; published: boolean; note?: string }

/** Applies one pair's choices (and the publish step when its standard is approved) to a parsed A file. */
export function applyPair(
  doc: Doc, pair: Rows['pairs'][number], reviewRows: Rows['rows'], choices: Record<string, Choice>, bDoc: Doc | undefined,
  approved: boolean, date: string, settledBy: SettledBy = () => undefined, noteVerdicts: Doc = {},
): PairResult {
  const out = structuredClone(doc);
  const changed: string[] = [];
  const replaced: string[] = [];
  const adjudicators = new Set<string>();
  let adjudicated = 0;
  let undecided = 0;
  for (const r of reviewRows) {
    const c = choices[r.item];
    const bv = bDoc?.verdicts?.[r.item];
    if (c === 'other' && noteVerdicts[r.item]) {
      out.verdicts[r.item] = structuredClone(noteVerdicts[r.item]);
      replaced.push(r.item);
      changed.push(`${r.item}:other`);
      continue;
    }
    if (c !== 'a' && !(c === 'b' && bv)) { undecided++; continue; }
    const name = settledBy(r.item, c);
    const label = name ? { by: 'model', adjudicated_by: name } : { by: 'human' };
    if (name) { adjudicators.add(name); adjudicated++; }
    if (c === 'a') Object.assign(out.verdicts[r.item], label);
    else {
      const { value, rationale, evidence, quotes_verified } = bv;
      const mine = out.verdicts[r.item];
      const same = isDeepStrictEqual([mine.value, mine.rationale, mine.evidence ?? []], [value, rationale, evidence ?? []]);
      // An identical reading keeps its key order, so the file diff shows only the changed keys.
      if (same) { if (quotes_verified === undefined) delete mine.quotes_verified; else mine.quotes_verified = quotes_verified; Object.assign(mine, label); }
      else {
        for (const k of ['rationale', 'evidence', 'quotes_verified']) delete mine[k];
        Object.assign(mine, { value, rationale, evidence, quotes_verified }, label);
      }
      if (!same) replaced.push(r.item);
    }
    changed.push(`${r.item}:${c}`);
  }
  const decided = changed.length - adjudicated;
  const settled = [...adjudicators].join(', ');
  let published = false;
  let note: string | undefined;
  if (approved && out.status === 'draft') {
    if (undecided) note = `${undecided} review row(s) skipped or undecided`;
    else {
      out.status = 'published';
      out.provenance.reviewers = [...new Set([...(out.provenance.reviewers ?? []), REVIEWER])];
      const counts = [`${pair.agreed} verdicts agreed`, ...(adjudicated ? [`${adjudicated} settled by ${settled}`] : []), `${decided} decided by the reviewer`];
      out.revisions.push({
        date, by: REVIEWER,
        summary: `Reviewed against a ${MODEL_B} cross-check: ${counts.join(', ')}.${adjudicated ? ` Approved by the reviewer at the level of the standard; rows settled by ${settled} were not checked one by one.` : ''}`,
        items: ['status', ...replaced],
      });
      published = true;
    }
  }
  // check-revisions requires an entry naming every verdict that changed, draft or not.
  if (!published && replaced.length) {
    const counts = [...(adjudicated ? [`${adjudicated} settled by ${settled}`] : []), ...(decided ? [`${decided} decided by the reviewer`] : [])];
    out.revisions.push({ date, by: decided ? REVIEWER : settled, summary: `Cross-check against ${MODEL_B} applied: ${counts.join(', ')}.`, items: replaced });
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
    options: { rows: { type: 'string' }, 'b-root': { type: 'string' }, decisions: { type: 'string' }, approvals: { type: 'string' }, adjudication: { type: 'string' }, 'note-verdicts': { type: 'string' }, 'dry-run': { type: 'boolean' } },
  });
  if (!values.rows || !values.decisions || !values.approvals || !values.adjudication) {
    console.error('usage: apply-review.ts --rows <rows.json> --decisions <file> --approvals <file> --adjudication <adjudication.json> [--b-root <dir>] [--note-verdicts <file>] [--dry-run]');
    process.exit(1);
  }
  const root = new URL('..', import.meta.url).pathname;
  const rows: Rows = JSON.parse(readFileSync(values.rows, 'utf8'));
  const decisionDocs = readDocs(readFileSync(values.decisions, 'utf8'));
  const decisions = new Map(decisionDocs.map((d) => [d.id, (d.data.choices ?? {}) as Record<string, Choice>]));
  // The review page drops a doc's `by` when a person edits one row, so provenance is per row: a choice
  // matching the adjudicator's own is the adjudicator's, and any other is the person's.
  const adjudication = JSON.parse(readFileSync(values.adjudication, 'utf8')) as { prompt_version: string; rows: Record<string, { choice: Choice }> };
  const adjudicator = `adjudicator-v${adjudication.prompt_version}`;
  const approved = new Set(readDocs(readFileSync(values.approvals, 'utf8')).filter((d) => d.data.approved === true).map((d) => d.id));
  const noteVerdicts: Doc = values['note-verdicts'] ? JSON.parse(readFileSync(values['note-verdicts'], 'utf8')) : {};
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
    const reviewRows = rows.rows.filter((x) => x.pair === pair.id);
    if (values['b-root']) try { bDoc = split(readFileSync(join(resolve(values['b-root']), rel), 'utf8')).doc; } catch { /* B file absent */ }
    bDoc ??= readingsFromRows(reviewRows, evidenceSources(c.assessments, pair.benchmark));
    const settledBy: SettledBy = (item, choice) => (adjudication.rows[`${pair.id}~${item}`]?.choice === choice ? adjudicator : undefined);
    const r = applyPair(doc, pair, reviewRows, choices, bDoc, isApproved, date, settledBy, noteVerdicts[pair.id]);
    if (!r.changed.length && !r.published) { if (r.note) log(`${pair.id}: stays draft (${r.note})`); continue; }
    let errs = errorsFor(c, r.doc);
    if (errs.length && r.published) {
      // Publishing is what failed validation: keep the decisions, leave the pair as a draft.
      const draft = applyPair(doc, pair, reviewRows, choices, bDoc, false, date, settledBy, noteVerdicts[pair.id]);
      const draftErrs = errorsFor(c, draft.doc);
      if (!draftErrs.length) { Object.assign(r, draft, { note: `would not validate when published: ${errs[0]}` }); errs = []; }
    }
    if (errs.length) { log(`${pair.id}: NOT APPLIED, would not validate: ${errs[0]}`); continue; }
    touched++;
    log(`${pair.id}: ${r.changed.join(' ') || 'no verdict changes'}${r.published ? ' -> published' : ''}${r.note ? ` (stays draft: ${r.note})` : ''}`);
    if (!values['dry-run']) writeFileSync(join(root, rel), render(header, r.doc));
  }
  log(touched ? `${values['dry-run'] ? 'would change' : 'changed'} ${touched} file(s)` : 'nothing to do');
  for (const d of decisionDocs) for (const [item, ch] of Object.entries(d.data.choices ?? {})) {
    if (ch === 'other' && !noteVerdicts[d.id]?.[item]) log(`FIX BY HAND ${d.id}~${item}: ${d.data.notes?.[item] || '(no note)'}`);
  }
}
