/**
 * Settle the disputed cross-check rows by a fixed rule cascade over the standard's own written rule
 * and the verified quotes (docs/adjudication.md). Two judge models answer only narrow, blind questions
 * ("which quote states this condition, and in which words"); code checks their words and derives the value and the choice.
 *   node --env-file=.env --import tsx scripts/adjudicate.ts --rows <rows.json> --out-dir <dir> [--max-pairs N] [--only-pair <b~s>]
 * Writes adjudication.json (per-row choice, value, rule, citations, evidence), decisions.json (apply-review
 * format, by "adjudicator-v1") and transcripts.jsonl (one line per chunk, both judges). A chunk already in
 * transcripts.jsonl with prompt version 4 and both replies parsed is not called again.
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

export const PROMPT_VERSION = '4';
export const VERSION = 'adjudicator-v1';
export const MODELS = ['openai/gpt-oss-120b', 'deepseek/deepseek-v4.1-flash-1017'] as const;
const CHUNK = 6; // judge 1 reasons at high effort, and its reasoning tokens count against max_tokens
const MAX_SPAN_WORDS = 30;
const ABC_DEFAULT = 'standards/abc.yaml:3';
const ABSENCE = 'docs/methodology.md:24';

export const SYSTEM =
  'You check whether quoted evidence satisfies a written rule from a benchmark-quality standard. The quotes were copied verbatim from a benchmark\'s paper or repository. Use only the quotes. Do not use outside knowledge about the benchmark and do not infer what a quote does not say. Reply with JSON only.';
const CREDIT =
  `For each condition, list the quotes that state it is true of this benchmark, each as {id, span}: span is the exact words of that quote (at most ${MAX_SPAN_WORDS} words, copied verbatim) that state the condition. List none if no quote states it. Every condition needs a reason of at most 25 words, also when no quote states it (say what the quotes lack). ` +
  'A quote that only names the topic, states an intention, or states a related fact does not establish it. ' +
  'The span must state the condition about this benchmark itself. Do not credit: a statement about another benchmark, model or prior study; a result or observation offered in place of the documented property; a plan or intention; a name or link in place of the property it would need to have. If the condition says every, all, both or fully, a quote covering only part does not establish it. ';
const TAIL =
  '3. If an N/A condition is given, answer na (required): state = holds (a quote states it is true of this benchmark), contradicted (a quote states it is false), or silent, with quote ids. ' +
  '4. If the scale is points: mentions = the quotes that mention the item\'s subject, each as {id, span} with the same verbatim span rule. A mention must name the criterion\'s own subject; a related result, a name or link, or a neighbouring topic is not a mention.';
export const INSTRUCTIONS =
  '1. Split the rule into requirements; every requirement must hold. Every condition is a consecutive piece of the rule text, character for character: never insert, re-order or complete words. Within a requirement give alternatives, each a condition copied word for word from the rule as one consecutive span. Only the rule\'s own word "or" (for example "X or no labels") creates alternatives: any one of them satisfies that requirement. "and", commas and lists join separate requirements, never alternatives. When alternatives share words ("in the repo or docs"), copy only the differing words as each alternative ("the repo", "docs") and read each with the shared words. A clause that only says what does not count ("... alone is not enough") is not a requirement; leave it out. A rule with one requirement and no "or" is one requirement with one alternative. ' +
  `2. ${CREDIT}${TAIL}`;
export const INSTRUCTIONS_B =
  '1. The requirements for each item are given as lists of conditions. Return one requirement per inner list and one alternative per condition, each condition copied unchanged and in the same order; do not add, merge, split or drop any, and never join conditions with OR. ' +
  `2. ${CREDIT}${TAIL}`;

type Value = Reading['value'] | number;
type Id = string | number;
export interface Quote { id: number; quote: string; locator: string; url: string }
export interface Reply {
  item: string;
  requirements: { alternatives: { condition: string; quotes: { id: Id; span: string }[]; reason: string }[] }[];
  na?: { state: 'holds' | 'contradicted' | 'silent'; quotes: Id[] };
  mentions?: { id: Id; span: string }[];
}
export type Cite = 'met' | 'na' | 'abc' | 'absence' | 'level';
export interface Span { id: number; span: string }
export interface Alt {
  requirement: number; condition: string; reason: string; reason_b: string; stated: boolean;
  judges: { a: number[]; b: number[] }; spans: { a: Span[]; b: Span[] };
}
export interface Settled { choice: 'a' | 'b' | 'skip'; value?: Value; rule: string; cite: Cite[]; level?: number; note?: string; alts?: Alt[]; na?: { state: string; a?: string; b?: string } }

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

const qid = (x: Id): number => (typeof x === 'number' ? x : Number(/^\s*q?(\d+)\s*$/i.exec(x)?.[1] ?? NaN));
const flat = (x: string) => normalize(x).replace(/[\s.,;:!?]+$/, ''); // trailing punctuation does not count

export interface Block { item: string; text: string; met: string; na?: string; points: boolean; quotes: Quote[] }
/** Judge 1 gets the rule and splits it; judge 2 (`given` = judge 1's replies) gets the split conditions, never judge 1's quote choices. */
export function buildMessages(blocks: Block[], given?: Reply[]): { role: 'system' | 'user'; content: string }[] {
  const per = blocks.map((b) => {
    const plan = JSON.stringify(given?.find((g) => g.item === b.item)?.requirements.map((q) => q.alternatives.map((a) => a.condition)));
    return `Item ${b.item}: ${b.text}\nRule (met when true of the evidence): ${b.met}\n` +
      (given ? `Requirements (all must hold; each inner list holds alternatives, any one satisfies its requirement): ${plan}\n` : '') +
      (b.na ? `N/A condition: ${b.na}\n` : '') + (b.points ? 'Scale: points\n' : '') +
      `Quotes:\n${b.quotes.length ? b.quotes.map((q) => `[Q${q.id}] "${q.quote}" (${q.locator})`).join('\n') : '(none)'}`;
  });
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: `${per.join('\n\n')}\n\nInstructions: ${given ? INSTRUCTIONS_B : INSTRUCTIONS}\nReply as {"rows":[{"item","requirements":[{"alternatives":[{"condition","quotes":[{"id","span"}],"reason"}]}],"na":{"state","quotes"},"mentions":[{"id","span"}]}]}, one entry per item above.` }];
}

/** `na` is required when any item in the call has an N/A condition. */
export const schema = (needNa: boolean) => ({
  type: 'object', additionalProperties: false, required: ['rows'],
  properties: { rows: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: needNa ? ['item', 'requirements', 'na'] : ['item', 'requirements'],
    properties: {
      item: { type: 'string' },
      requirements: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['alternatives'], properties: {
        alternatives: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['condition', 'quotes', 'reason'], properties: {
          condition: { type: 'string' },
          quotes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'span'], properties: { id: { type: 'string' }, span: { type: 'string' } } } },
          reason: { type: 'string', minLength: 1 } } } } } } },
      na: { type: 'object', additionalProperties: false, required: ['state', 'quotes'],
        properties: { state: { type: 'string', enum: ['holds', 'contradicted', 'silent'] }, quotes: { type: 'array', items: { type: 'string' } } } },
      mentions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'span'], properties: { id: { type: 'string' }, span: { type: 'string' } } } },
    } } } },
});

/** Code checks on one judge's reply: it has requirements, every condition is a span of the rule, every quote id exists. Returns the problem, if any. */
export function check(r: Reply | undefined, met: string, nQuotes: number): string | undefined {
  if (!r) return 'reply has no entry for this item';
  if (!Array.isArray(r.requirements) || !r.requirements.length || r.requirements.some((q) => !Array.isArray(q.alternatives) || !q.alternatives.length)) return 'returned no requirements';
  const alts = r.requirements.flatMap((q) => q.alternatives);
  const rule = flat(met);
  if (r.requirements.some((q) => q.alternatives.length > 1) && !/\bor\b/i.test(met)) return 'alternatives, but the rule has no "or"';
  const bad = alts.find((a) => !a.condition.trim() || !rule.includes(flat(a.condition)));
  if (bad) return `condition is not a span of the rule: "${bad.condition}"`;
  const ids = [...alts.flatMap((a) => a.quotes.map((q) => q.id)), ...(r.na?.quotes ?? []), ...(r.mentions ?? []).map((m) => m.id)].map(qid);
  if (!ids.every((n) => Number.isInteger(n) && n >= 1 && n <= nQuotes)) return 'cited a quote id that does not exist';
}

/** Quotes a judge credits (for one alternative, or as mentions): the span must be at most 30 words and a substring of the quote. A failed span is not credited. */
const credit = (qs: { id: Id; span: string }[], quotes: Quote[]): Span[] => {
  const out = new Map<number, Span>();
  for (const q of qs) {
    const s = flat(q.span);
    if (s && q.span.trim().split(/\s+/).length <= MAX_SPAN_WORDS && flat(quotes[qid(q.id) - 1]!.quote).includes(s)) out.set(qid(q.id), { id: qid(q.id), span: q.span });
  }
  return [...out.values()];
};

export interface SettleIn { standard: string; item: string; met: string; hasNa: boolean; points: boolean; quotes: Quote[]; a: Value; b: Value | null; reply: Reply | undefined; reply2: Reply | undefined; noCall?: boolean }

/** Code checks on both judges' replies, then the evidence-determined value V and the choice. Pure. */
export function settle(i: SettleIn): Settled {
  const skip = (note: string): Settled => ({ choice: 'skip', rule: 'not settled', cite: [], note });
  for (const [who, r] of [['judge 1', i.reply], ['judge 2', i.reply2]] as const) {
    const e = check(r, i.met, i.quotes.length);
    if (e) return skip(`${who}: ${e}`);
  }
  const [r1, r2] = [i.reply!, i.reply2!];
  const by2 = new Map(r2.requirements.flatMap((q) => q.alternatives).map((a) => [flat(a.condition), a])); // judge 2's answer for a condition judge 1 split out; a dropped one gets no credit
  if (i.hasNa && !(r1.na && r2.na)) return skip('a judge did not answer the N/A condition');
  // Each alternative is stated only when both judges credit a span-verified quote (not necessarily the same one).
  const alts: Alt[] = r1.requirements.flatMap((q, k) => q.alternatives.map((a) => {
    const b = by2.get(flat(a.condition));
    const [sa, sb] = [credit(a.quotes, i.quotes), b ? credit(b.quotes, i.quotes) : []];
    return { requirement: k, condition: a.condition, reason: a.reason, reason_b: b?.reason ?? 'judge 2 dropped this condition', stated: !!sa.length && !!sb.length, judges: { a: sa.map((x) => x.id), b: sb.map((x) => x.id) }, spans: { a: sa, b: sb } };
  }));
  const total = r1.requirements.length;
  const stated = r1.requirements.filter((_, k) => alts.some((a) => a.requirement === k && a.stated)).length; // requirements ANDed, alternatives ORed
  const frac = `${stated} of ${total} requirements stated by a quote both judges credit`;
  let value: Value;
  let text: string;
  const cite: Cite[] = ['met'];
  let level: number | undefined;
  const [s1, s2] = [r1.na?.state, r2.na?.state];
  const state = !i.hasNa ? undefined : s1 === 'holds' && s2 === 'holds' ? 'holds' : s1 === 'contradicted' || s2 === 'contradicted' ? 'contradicted' : 'silent';
  const na = state ? { state, a: s1, b: s2 } : undefined;
  if (state === 'holds' || (state === 'silent' && i.standard === 'abc' && i.item.startsWith('O.'))) {
    value = 'n/a'; cite.push('na');
    if (state === 'holds') text = 'n/a: a quote states the item\'s N/A condition (both judges)';
    else { text = 'n/a: no quote on the N/A condition, and ABC treats outcome-validity items as n/a unless the benchmark uses that method'; cite.push('abc'); }
  } else if (i.points) {
    const m2 = new Set(credit(r2.mentions ?? [], i.quotes).map((x) => x.id));
    const m = credit(r1.mentions ?? [], i.quotes).filter((x) => m2.has(x.id)).length; // mentions: intersection of span-verified ids
    level = stated === total ? 15 : stated ? 10 : m ? 5 : 0;
    value = level; cite.push('level');
    text = `${level}: ${level >= 10 ? frac : level === 5 ? `no requirement stated, ${m} quote(s) discuss the subject` : 'no requirement stated and no quote discusses the subject'}`;
    if (level === 0) cite.push('absence');
  } else if (stated === total) { value = 'met'; text = `met: ${frac}`; }
  else { value = 'unmet'; text = `unmet: ${frac}`; cite.push('absence'); }
  if (i.noCall) text += ' (decided without a judge call: no verified quote in either reading)';
  const positive = (v: Value | null) => typeof v === 'number' && v > 0;
  if (i.points && positive(i.a) && positive(i.b))
    return { choice: 'skip', value, rule: text, cite, level, alts, na, note: 'BetterBench separates 5, 10 and 15 only by its generic level meanings; the quotes cannot choose between two positive levels.' };
  const choice = i.a === value ? 'a' : i.b !== null && i.b === value ? 'b' : 'skip';
  return { choice, value, rule: text, cite, level, alts, na, ...(choice === 'skip' ? { note: `neither reading matches evidence value ${value}` } : {}) };
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
  // maxTokens: six rows of reasoning plus answer do not fit the default 6000. Judge 1 reasons at high effort for this script only (config/models.yaml stays at low).
  const cfgs = MODELS.map((m) => { const { llm, keyEnv } = llmConfig(corpus, m); if (keyEnv && !llm.apiKey) { console.error(`${keyEnv} is not set`); process.exit(1); } return { ...llm, maxTokens: 16000 }; });
  const cfg2 = cfgs[1]!;
  const cfg1: typeof cfg2 = { ...cfgs[0]!, maxTokens: 48000, extra: { ...cfgs[0]!.extra, reasoning: { effort: 'high' } } };
  const rows = (JSON.parse(readFileSync(resolve(values.rows), 'utf8')) as Rows).rows;
  let pairs = [...new Set(rows.map((r) => r.pair))].filter((p) => !values['only-pair'] || p === values['only-pair']);
  if (values['max-pairs']) pairs = pairs.slice(0, Number(values['max-pairs']));
  const out = resolve(values['out-dir']);
  mkdirSync(out, { recursive: true });
  const tPath = join(out, 'transcripts.jsonl');
  const done = new Map<string, [Reply[], Reply[]]>();
  if (existsSync(tPath))
    for (const l of readFileSync(tPath, 'utf8').split('\n').filter(Boolean)) {
      const t = JSON.parse(l) as { pair: string; chunk: number; prompt_version?: string; keys: string[]; judges?: { reply: { rows: Reply[] } | null }[] };
      if (t.prompt_version === PROMPT_VERSION && t.judges?.length === 2 && t.judges.every((j) => j.reply)) done.set(`${t.prompt_version}#${t.pair}#${t.chunk}#${t.keys.join(',')}`, [t.judges[0]!.reply!.rows, t.judges[1]!.reply!.rows]);
    }
  /** One judge call with retries; the raw reply and any error are kept for the transcript. */
  const ask = async (cfg: typeof cfg1, messages: ReturnType<typeof buildMessages>, needNa: boolean) => {
    let raw: string | undefined;
    let rows: Reply[] | undefined;
    let error: string | undefined;
    for (let n = 0; n < 5 && !rows; n++) {
      const t0 = Date.now();
      try {
        raw = (await chat(cfg, messages, undefined, schema(needNa))).content;
        rows = (parseJson(raw) as { rows: Reply[] }).rows;
        if (!Array.isArray(rows)) { rows = undefined; throw new Error('reply has no rows array'); }
        rows = rows.map((v) => ({ ...v, item: String(v.item).replace(/^\s*item\s+/i, '').split(':')[0]!.trim() })); // judges echo "Item X" or "X: text"
        error = undefined;
      } catch (e) {
        error = (e as Error).message;
        console.log(`  ${cfg.model} attempt ${n + 1} failed after ${Math.round((Date.now() - t0) / 1000)} s: ${error}`);
        if (n < 4) await sleep(e instanceof RateLimited ? 5000 * 2 ** n : 2000 * 2 ** n);
      }
    }
    return { model: cfg.model, messages, raw, reply: rows ? { rows } : null, error };
  };
  let calls = 0;
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
    const emit = (r: Row, replies: [Reply[], Reply[]] | undefined, error: string | undefined, noCall: boolean) => {
      const m = meta(r);
      const [x, y] = [replies?.[0].find((v) => v.item === r.item), replies?.[1].find((v) => v.item === r.item)];
      const s: Settled = replies ? settle({ standard: r.standard, item: r.item, met: m.met, hasNa: !!m.na, points: m.points, quotes: m.quotes, a: r.a.value, b: r.b ? r.b.value : null, reply: x, reply2: y, noCall })
        : { choice: 'skip', rule: 'not settled', cite: [], note: `judge call failed: ${error}` };
      const q = (ids: Id[]) => ids.map((i) => m.quotes[qid(i) - 1]).filter((v): v is Quote => !!v);
      tally[s.choice]++;
      if (s.choice === 'skip') tally[!replies ? 'failedCall' : s.value === undefined ? 'failedCheck' : s.note?.startsWith('BetterBench') ? 'twoLevels' : 'noMatch']++;
      (choices[pair] ??= {})[r.item] = s.choice;
      result[r.key] = {
        choice: s.choice, value: s.value ?? null, rule: s.rule, cites: citations(root, r.standard, r.item, s),
        conditions: (s.alts ?? []).map((a) => ({ requirement: a.requirement, condition: a.condition, reason: a.reason, reason_b: a.reason_b, quotes: q(a.stated ? [...new Set([...a.judges.a, ...a.judges.b])] : []), judges: a.judges, spans: a.spans })),
        ...(s.na && x?.na && y?.na ? { na: { state: s.na.state, a: s.na.a, b: s.na.b, quotes: q([...x.na.quotes, ...y.na.quotes]) } } : {}),
        ...(s.note ? { note: s.note } : {}),
      };
    };
    // No verified quote in either reading: nothing for a judge to read, so the cascade runs on an empty reply.
    const [empty, judged] = [prows.filter((r) => !meta(r).quotes.length), prows.filter((r) => meta(r).quotes.length)];
    for (const r of empty) {
      const m = meta(r);
      const e: Reply = { item: r.item, requirements: [{ alternatives: [{ condition: m.met, quotes: [], reason: 'No verified quote in either reading.' }] }], ...(m.na ? { na: { state: 'silent' as const, quotes: [] } } : {}), mentions: [] };
      emit(r, [[e], [e]], undefined, true);
    }
    for (let c = 0; c * CHUNK < judged.length; c++) {
      const chunk = judged.slice(c * CHUNK, (c + 1) * CHUNK);
      const blocks: Block[] = chunk.map((r) => { const m = meta(r); return { item: r.item, text: r.text, met: m.met, na: m.na, points: m.points, quotes: m.quotes }; });
      const key = `${PROMPT_VERSION}#${pair}#${c}#${chunk.map((r) => r.key).join(',')}`;
      let replies = done.get(key);
      let error: string | undefined;
      if (!replies) {
        const j1 = await ask(cfg1, buildMessages(blocks), blocks.some((b) => b.na));
        calls++;
        const judges = [j1];
        // Judge 2 only reads items whose judge-1 split passed the code checks, and sees the conditions, not judge 1's quotes.
        const ok = j1.reply ? blocks.filter((b) => !check(j1.reply!.rows.find((v) => v.item === b.item), b.met, b.quotes.length)) : [];
        if (j1.reply) {
          const j2 = ok.length ? await ask(cfg2, buildMessages(ok, j1.reply.rows), ok.some((b) => b.na)) : { model: cfg2.model, messages: [], raw: undefined, reply: { rows: [] as Reply[] }, error: undefined };
          if (ok.length) calls++;
          judges.push(j2);
        }
        error = judges.map((j) => j.error).find(Boolean);
        replies = judges.length === 2 && judges.every((j) => j.reply) ? [judges[0]!.reply!.rows, judges[1]!.reply!.rows] : undefined;
        appendFileSync(tPath, JSON.stringify({ pair, chunk: c, prompt_version: PROMPT_VERSION, keys: chunk.map((r) => r.key), judges }) + '\n');
      }
      for (const r of chunk) emit(r, replies, error, false);
      console.log(`${pair} chunk ${c}: ${chunk.length} rows${error ? ` (error: ${error})` : ''}`);
    }
    if (empty.length) console.log(`${pair}: ${empty.length} rows decided without a judge call`);
  }
  const now = new Date().toISOString();
  writeFileSync(join(out, 'adjudication.json'), JSON.stringify({ version: VERSION, model: [...MODELS], prompt_version: PROMPT_VERSION, generated_on: now.slice(0, 10), rows: result }, null, 1) + '\n');
  writeFileSync(join(out, 'decisions.json'), JSON.stringify(pairs.map((id) => ({ id, data: { choices: choices[id] ?? {}, updated_at: now, by: VERSION } })), null, 1) + '\n');
  console.log(`${pairs.length} pairs, ${Object.keys(result).length} rows: a=${tally.a} b=${tally.b} skip=${tally.skip} (failed code check ${tally.failedCheck}, failed call ${tally.failedCall}, neither reading matches ${tally.noMatch}, two positive BetterBench levels ${tally.twoLevels}); ${calls} judge calls -> ${out}`);
}
