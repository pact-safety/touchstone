/**
 * Settle the disputed cross-check rows by a fixed rule cascade over the standard's own written rule
 * and the verified quotes (docs/adjudication.md). A judge model answers only narrow, blind questions
 * ("which quote states this condition"); code derives the value and the choice.
 *   node --env-file=.env --import tsx scripts/adjudicate.ts --rows <rows.json> --out-dir <dir> [--max-pairs N] [--only-pair <b~s>]
 * Writes adjudication.json (per-row choice, value, rule, citations, evidence), decisions.json (apply-review
 * format, by "adjudicator-v1") and transcripts.jsonl (one line per call). A pair already in transcripts.jsonl
 * with a parsed reply is not called again.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chat, parseJson, RateLimited } from '../src/assess/llm.ts';
import { normalize } from '../src/assess/text.ts';
import { llmConfig } from '../src/llm-config.ts';
import { load } from '../src/load.ts';
import type { Reading, Row, Rows } from './crosscheck.ts';

export const PROMPT_VERSION = '2';
export const VERSION = 'adjudicator-v1';
export const MODEL = 'openai/gpt-oss-120b';
const CHUNK = 12;
const ABC_DEFAULT = 'standards/abc.yaml:3';
const ABSENCE = 'docs/methodology.md:24';

export const SYSTEM =
  'You check whether quoted evidence satisfies a written rule from a benchmark-quality standard. The quotes were copied verbatim from a benchmark\'s paper or repository. Use only the quotes. Do not use outside knowledge about the benchmark and do not infer what a quote does not say. Reply with JSON only.';
export const INSTRUCTIONS =
  '1. Split the rule into the separate conditions it requires, copying each condition\'s words exactly from the rule as one consecutive span. A rule with one requirement is one condition. ' +
  '2. For each condition, list the ids of quotes that state it is true of this benchmark; list none if no quote states it. Every condition needs a reason of at most 25 words, also when no quote states it (say what the quotes lack). A quote that only names the topic, states an intention, or states a related fact does not establish it. ' +
  '3. If an N/A condition is given: na = holds (a quote states it is true of this benchmark), contradicted (a quote states it is false), or silent, with quote ids. ' +
  '4. If the scale is points: mentions = ids of quotes that discuss the item\'s subject at all.';

type Value = Reading['value'] | number;
export interface Quote { id: number; quote: string; locator: string; url: string }
export interface Reply {
  item: string;
  conditions: { condition: string; quotes: (string | number)[]; reason: string }[];
  na?: { state: 'holds' | 'contradicted' | 'silent'; quotes: (string | number)[] };
  mentions?: (string | number)[];
}
export type Cite = 'met' | 'na' | 'abc' | 'absence' | 'level';
export interface Settled { choice: 'a' | 'b' | 'skip'; value?: Value; rule: string; cite: Cite[]; level?: number; note?: string }

/** A reading's quotes are pooled only when they were verified (null = not recorded, kept); de-duplicated by normalised text. */
export function poolQuotes(row: Pick<Row, 'a' | 'b'>): Quote[] {
  const seen = new Set<string>();
  const out: Quote[] = [];
  for (const r of [row.a, row.b]) {
    if (!r || r.quotes_verified === false) continue;
    for (const e of r.evidence) {
      const n = normalize(e.quote);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push({ id: out.length + 1, quote: e.quote, locator: e.locator, url: e.url });
    }
  }
  return out;
}

const qid = (x: string | number): number => (typeof x === 'number' ? x : Number(/^\s*q?(\d+)\s*$/i.exec(x)?.[1] ?? NaN));

export interface Block { item: string; text: string; met: string; na?: string; points: boolean; quotes: Quote[] }
export function buildMessages(blocks: Block[]): { role: 'system' | 'user'; content: string }[] {
  const per = blocks.map((b) =>
    `Item ${b.item}: ${b.text}\nRule (met when true of the evidence): ${b.met}\n` +
    (b.na ? `N/A condition: ${b.na}\n` : '') + (b.points ? 'Scale: points\n' : '') +
    `Quotes:\n${b.quotes.length ? b.quotes.map((q) => `[Q${q.id}] "${q.quote}" (${q.locator})`).join('\n') : '(none)'}`);
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: `${per.join('\n\n')}\n\nInstructions: ${INSTRUCTIONS}\nReply as {"rows":[{"item","conditions":[{"condition","quotes","reason"}],"na":{"state","quotes"},"mentions"}]}, one entry per item above.` }];
}

export const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['rows'],
  properties: { rows: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['item', 'conditions'],
    properties: {
      item: { type: 'string' },
      conditions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['condition', 'quotes', 'reason'],
        properties: { condition: { type: 'string' }, quotes: { type: 'array', items: { type: 'string' } }, reason: { type: 'string', minLength: 1 } } } },
      na: { type: 'object', additionalProperties: false, required: ['state', 'quotes'],
        properties: { state: { type: 'string', enum: ['holds', 'contradicted', 'silent'] }, quotes: { type: 'array', items: { type: 'string' } } } },
      mentions: { type: 'array', items: { type: 'string' } },
    } } } },
};

export interface SettleIn { standard: string; item: string; met: string; hasNa: boolean; points: boolean; nQuotes: number; a: Value; b: Value | null; reply: Reply | undefined; noCall?: boolean }

/** Code checks on the judge's reply, then the evidence-determined value V and the choice. Pure. */
export function settle(i: SettleIn): Settled {
  const skip = (note: string): Settled => ({ choice: 'skip', rule: 'not settled', cite: [], note });
  const r = i.reply;
  if (!r) return skip('judge reply has no entry for this item');
  const flat = (x: string) => normalize(x).replace(/[\s.,;:!?]+$/, ''); // trailing punctuation does not count
  const rule = flat(i.met);
  if (!r.conditions.length) return skip('judge returned no conditions');
  const bad = r.conditions.find((c) => !c.condition.trim() || !rule.includes(flat(c.condition)));
  if (bad) return skip(`condition is not a span of the rule: "${bad.condition}"`);
  const ok = (ids: (string | number)[]) => ids.map(qid).every((n) => Number.isInteger(n) && n >= 1 && n <= i.nQuotes);
  const all = [...r.conditions.flatMap((c) => c.quotes), ...(r.na?.quotes ?? []), ...(r.mentions ?? [])];
  if (!ok(all)) return skip('judge cited a quote id that does not exist');
  const stated = r.conditions.filter((c) => c.quotes.length).length;
  const total = r.conditions.length;
  const frac = `${stated} of ${total} conditions stated by a quote`;
  let value: Value;
  let text: string;
  const cite: Cite[] = ['met'];
  let level: number | undefined;
  const state = i.hasNa ? r.na?.state : undefined;
  if (state === 'holds' || (state === 'silent' && i.standard === 'abc' && i.item.startsWith('O.'))) {
    value = 'n/a'; cite.push('na');
    if (state === 'holds') text = 'n/a: a quote states the item\'s N/A condition';
    else { text = 'n/a: no quote on the N/A condition, and ABC treats outcome-validity items as n/a unless the benchmark uses that method'; cite.push('abc'); }
  } else if (i.points) {
    const m = r.mentions?.length ?? 0;
    level = stated === total ? 15 : stated ? 10 : m ? 5 : 0;
    value = level; cite.push('level');
    text = `${level}: ${level >= 10 ? frac : level === 5 ? `no condition stated, ${m} quote(s) discuss the subject` : 'no condition stated and no quote discusses the subject'}`;
    if (level === 0) cite.push('absence');
  } else if (stated === total) { value = 'met'; text = `met: ${frac}`; }
  else { value = 'unmet'; text = `unmet: ${frac}`; cite.push('absence'); }
  if (i.noCall) text += ' (decided without a judge call: no verified quote in either reading)';
  const positive = (v: Value | null) => typeof v === 'number' && v > 0;
  if (i.points && positive(i.a) && positive(i.b))
    return { choice: 'skip', value, rule: text, cite, level, note: 'BetterBench separates 5, 10 and 15 only by its generic level meanings; the quotes cannot choose between two positive levels.' };
  const choice = i.a === value ? 'a' : i.b !== null && i.b === value ? 'b' : 'skip';
  return { choice, value, rule: text, cite, level, ...(choice === 'skip' ? { note: `neither reading matches evidence value ${value}` } : {}) };
}

/** 1-based lines of an item's `met:`, `not_applicable:` and `text:` in a standard's YAML (search stops at the next item). */
export function itemLines(yaml: string, item: string): { met?: number; na?: number; text?: number } {
  const lines = yaml.split('\n');
  const esc = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // block style `- id: X` or flow style `- { id: X, ...`; the id must end there so 1.2.1 does not match 1.2.1a
  const start = lines.findIndex((l) => new RegExp(`^\\s*-\\s*(?:\\{\\s*)?id:\\s*["']?${esc}["']?\\s*(?:$|[,}])`).test(l));
  if (start < 0) return {};
  const out: { met?: number; na?: number; text?: number } = {};
  for (let n = start; n < lines.length && (n === start || !/^\s*-\s*(?:\{\s*)?id:/.test(lines[n]!)); n++) { // flow style: met: sits on the start line
    const l = lines[n]!;
    if (out.met === undefined && /(?:^|[\s{,])met:/.test(l)) out.met = n + 1;
    if (out.na === undefined && /(?:^|[\s{,])not_applicable:/.test(l)) out.na = n + 1;
    if (out.text === undefined && /(?:^|[\s{,])text:/.test(l)) out.text = n + 1;
  }
  return out;
}

/** file:line of a points level in `level_meanings`. */
export function levelLine(yaml: string, level: number): number | undefined {
  const lines = yaml.split('\n');
  const from = lines.findIndex((l) => /^\s*level_meanings:/.test(l));
  if (from < 0) return undefined;
  const n = lines.findIndex((l, k) => k > from && new RegExp(`^\\s*["']?${level}["']?:`).test(l));
  return n < 0 ? undefined : n + 1;
}

/** The citation strings for a settled row. A standard without a `met:` rule (BetterBench) cites the item's `text:` line, which is the rule used. */
export function citations(root: string, standard: string, item: string, s: Pick<Settled, 'cite' | 'level'>): string[] {
  const file = `standards/${standard}.yaml`;
  const yaml = readFileSync(join(root, file), 'utf8');
  const l = itemLines(yaml, item);
  const at = (n?: number) => (n ? [`${file}:${n}`] : []);
  return [...new Set(s.cite.flatMap((c) =>
    c === 'met' ? at(l.met ?? l.text) : c === 'na' ? at(l.na) : c === 'abc' ? [ABC_DEFAULT] : c === 'absence' ? [ABSENCE]
      : at(s.level === undefined ? undefined : levelLine(yaml, s.level))))]; // flow-style items put met: and not_applicable: on one line
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values } = parseArgs({ options: { rows: { type: 'string' }, 'out-dir': { type: 'string' }, 'max-pairs': { type: 'string' }, 'only-pair': { type: 'string' } } });
  if (!values.rows || !values['out-dir']) { console.error('usage: adjudicate.ts --rows <rows.json> --out-dir <dir> [--max-pairs N] [--only-pair <b~s>]'); process.exit(1); }
  const root = new URL('..', import.meta.url).pathname;
  const corpus = load(root);
  const { llm, keyEnv } = llmConfig(corpus, MODEL);
  if (keyEnv && !llm.apiKey) { console.error(`${keyEnv} is not set`); process.exit(1); }
  const cfg = { ...llm, maxTokens: 16000 }; // twelve rows of reasoning plus answer do not fit the default 6000
  const rows = (JSON.parse(readFileSync(resolve(values.rows), 'utf8')) as Rows).rows;
  let pairs = [...new Set(rows.map((r) => r.pair))].filter((p) => !values['only-pair'] || p === values['only-pair']);
  if (values['max-pairs']) pairs = pairs.slice(0, Number(values['max-pairs']));
  const out = resolve(values['out-dir']);
  mkdirSync(out, { recursive: true });
  const tPath = join(out, 'transcripts.jsonl');
  const done = new Map<string, Reply[]>();
  if (existsSync(tPath))
    for (const l of readFileSync(tPath, 'utf8').split('\n').filter(Boolean)) {
      const t = JSON.parse(l) as { pair: string; chunk: number; prompt_version?: string; keys: string[]; reply: { rows: Reply[] } | null };
      if (t.reply) done.set(`${t.prompt_version}#${t.pair}#${t.chunk}#${t.keys.join(',')}`, t.reply.rows);
    }
  const std = (id: string) => corpus.standards.find((s) => s.value.id === id)!.value;
  const result: Record<string, unknown> = {};
  const choices: Record<string, Record<string, string>> = {};
  const tally = { a: 0, b: 0, skip: 0, failedCheck: 0, failedCall: 0, noMatch: 0, twoLevels: 0 };
  for (const pair of pairs) {
    const prows = rows.filter((r) => r.pair === pair);
    const meta = (r: Row) => {
      const it = std(r.standard).groups.flatMap((g) => g.items).find((x) => x.id === r.item)!;
      return { it, na: it.guidance?.not_applicable, points: std(r.standard).scoring?.scheme === 'points', quotes: poolQuotes(r), met: r.met || r.text };
    };
    const emit = (r: Row, replies: Reply[] | undefined, error: string | undefined, noCall: boolean) => {
      const m = meta(r);
      const reply = replies?.find((x) => x.item === r.item);
      const s: Settled = replies ? settle({ standard: r.standard, item: r.item, met: m.met, hasNa: !!m.na, points: m.points, nQuotes: m.quotes.length, a: r.a.value, b: r.b ? r.b.value : null, reply, noCall })
        : { choice: 'skip', rule: 'not settled', cite: [], note: `judge call failed: ${error}` };
      const q = (ids: (string | number)[]) => ids.map((i) => m.quotes[qid(i) - 1]).filter((x): x is Quote => !!x);
      tally[s.choice]++;
      if (s.choice === 'skip') tally[!replies ? 'failedCall' : s.value === undefined ? 'failedCheck' : s.note?.startsWith('BetterBench') ? 'twoLevels' : 'noMatch']++;
      (choices[pair] ??= {})[r.item] = s.choice;
      result[r.key] = {
        choice: s.choice, value: s.value ?? null, rule: s.rule, cites: citations(root, r.standard, r.item, s),
        conditions: (reply?.conditions ?? []).map((cd) => ({ condition: cd.condition, reason: cd.reason, quotes: q(cd.quotes) })),
        ...(reply?.na && m.na ? { na: { state: reply.na.state, quotes: q(reply.na.quotes) } } : {}),
        ...(s.note ? { note: s.note } : {}),
      };
    };
    // No verified quote in either reading: nothing for a judge to read, so the cascade runs on an empty reply.
    const [empty, judged] = [prows.filter((r) => !meta(r).quotes.length), prows.filter((r) => meta(r).quotes.length)];
    for (const r of empty) {
      const m = meta(r);
      emit(r, [{ item: r.item, conditions: [{ condition: m.met, quotes: [], reason: 'No verified quote in either reading.' }], ...(m.na ? { na: { state: 'silent' as const, quotes: [] } } : {}), mentions: [] }], undefined, true);
    }
    for (let c = 0; c * CHUNK < judged.length; c++) {
      const chunk = judged.slice(c * CHUNK, (c + 1) * CHUNK);
      const blocks: Block[] = chunk.map((r) => { const m = meta(r); return { item: r.item, text: r.text, met: m.met, na: m.na, points: m.points, quotes: m.quotes }; });
      const messages = buildMessages(blocks);
      const key = `${PROMPT_VERSION}#${pair}#${c}#${chunk.map((r) => r.key).join(',')}`;
      let replies = done.get(key);
      let error: string | undefined;
      if (!replies) {
        let raw: string | undefined;
        for (let n = 0; n < 5 && !replies; n++) {
          try {
            raw = (await chat(cfg, messages, undefined, SCHEMA)).content;
            replies = (parseJson(raw) as { rows: Reply[] }).rows;
            if (!Array.isArray(replies)) { replies = undefined; throw new Error('reply has no rows array'); }
            error = undefined;
          } catch (e) {
            error = (e as Error).message;
            if (n < 4) await sleep(e instanceof RateLimited ? 5000 * 2 ** n : 2000 * 2 ** n);
          }
        }
        appendFileSync(tPath, JSON.stringify({ pair, chunk: c, prompt_version: PROMPT_VERSION, keys: chunk.map((r) => r.key), model: cfg.model, messages, raw, reply: replies ? { rows: replies } : null, error }) + '\n');
      }
      for (const r of chunk) emit(r, replies, error, false);
      console.log(`${pair} chunk ${c}: ${chunk.length} rows${error ? ` (error: ${error})` : ''}`);
    }
    if (empty.length) console.log(`${pair}: ${empty.length} rows decided without a judge call`);
  }
  const now = new Date().toISOString();
  writeFileSync(join(out, 'adjudication.json'), JSON.stringify({ version: VERSION, model: cfg.model, prompt_version: PROMPT_VERSION, generated_on: now.slice(0, 10), rows: result }, null, 1) + '\n');
  writeFileSync(join(out, 'decisions.json'), JSON.stringify(pairs.map((id) => ({ id, data: { choices: choices[id] ?? {}, updated_at: now, by: VERSION } })), null, 1) + '\n');
  console.log(`${pairs.length} pairs, ${Object.keys(result).length} rows: a=${tally.a} b=${tally.b} skip=${tally.skip} (failed code check ${tally.failedCheck}, failed call ${tally.failedCall}, neither reading matches ${tally.noMatch}, two positive BetterBench levels ${tally.twoLevels}) -> ${out}`);
}
