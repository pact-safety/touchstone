import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordedOn } from '../src/assess/resume.ts';
import { load } from '../src/load.ts';
import { validate } from '../src/validate.ts';
import { score } from '../src/engine.ts';
import { assess, finalize, selectExcerpts } from '../src/assess/run.ts';
import { parseJson } from '../src/assess/llm.ts';
import { chunk, normalize, rank, verifyQuote, sha256, type Chunk } from '../src/assess/text.ts';
import type { FetchedSource } from '../src/assess/sources.ts';
import { queue } from '../src/watch.ts';
import { triage, parseIssueForm } from '../src/triage.ts';

const corpus = load(new URL('..', import.meta.url).pathname);
const std = (id: string) => corpus.standards.find((s) => s.value.id === id)!.value;
const bench = (id: string) => corpus.benchmarks.find((b) => b.value.id === id)!.value;

const PAPER = `We define truthfulness as the model avoiding false statements that mimic common human misconceptions.

The benchmark contains 817 questions spanning 38 categories, including health, law, finance and politics.

We report 95% confidence intervals for all primary scores using bootstrap resampling.

Limitations: the questions are in English only and were written by the authors.`;

const source = (): FetchedSource => {
  const text = PAPER;
  return {
    snapshot: { kind: 'paper', url: 'https://arxiv.org/abs/2109.07958v2', ref: 'v2', sha256: sha256(text), chars: text.length },
    chunks: chunk('paper:p1', '2109.07958v2 page 1', text, 200),
  };
};

/** A fake OpenAI-compatible endpoint that answers every group with the given verdict builder. */
const fakeLlm = (answer: (itemIds: string[], excerptIds: string[]) => unknown) => {
  const calls: string[] = [];
  const f: typeof fetch = async (_url, init) => {
    const prompt = JSON.parse(String(init!.body)).messages[0].content as string;
    calls.push(prompt);
    const items = [...prompt.matchAll(/^- id: (\S+)/gm)].map((m) => m[1]!);
    const excerpts = [...prompt.matchAll(/^\[(\S+)\]/gm)].map((m) => m[1]!);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer(items, excerpts)) } }] }), { status: 200 });
  };
  return { f, calls };
};

const run = (standardId: string, answer: Parameters<typeof fakeLlm>[0], maxCalls?: number) => {
  const { f, calls } = fakeLlm(answer);
  return assess({
    benchmark: bench('truthfulqa'), standard: std(standardId), sources: [source()],
    llm: { baseUrl: 'http://fake', model: 'gpt-oss:20b', temperature: 0, seed: 1, maxTokens: 100 },
    provider: 'ollama', license: 'Apache-2.0', runOn: '2026-10-26', transcriptPath: 'data/runs/x.jsonl',
    pins: { paper_version: 'v2' }, fetchImpl: f, maxCalls,
  }).then((r) => ({ ...r, prompts: calls }));
};

describe('text', () => {
  it('normalises quotes, dashes, hyphenation and whitespace', () => {
    expect(normalize('“Bootstrap”  resam-\n pling — 95%')).toBe('"bootstrap" resampling - 95%');
  });
  it('verifies only verbatim quotes of at least 12 characters', () => {
    expect(verifyQuote('817 questions spanning 38 categories', PAPER)).toBe(true);
    expect(verifyQuote('900 questions spanning 38 categories', PAPER)).toBe(false);
    expect(verifyQuote('817', PAPER)).toBe(false);
  });
  it('ranks deterministically', () => {
    const cs = chunk('paper:p1', 'p1', PAPER, 120);
    expect(rank(cs, 'confidence intervals bootstrap', 2).map((c) => c.id)).toEqual(rank(cs, 'confidence intervals bootstrap', 2).map((c) => c.id));
    expect(rank(cs, 'confidence intervals bootstrap', 1)[0]!.text).toContain('confidence intervals');
  });
});

describe('quote check in finalize', () => {
  const A = 'The benchmark contains 817 questions spanning 38 categories, including health, law and finance. Scores are averaged over five runs.';
  const B = 'We report 95% confidence intervals for all primary scores using bootstrap resampling.';
  const C = 'Limitations: the questions are in English only and were written by the authors.';
  const mk = (id: string, text: string): Chunk => ({ id, source: 'paper:p1', locator: `loc ${id}`, text });
  const [ca, cb, cc] = [mk('paper:p1#0', A), mk('paper:p1#1', B), mk('paper:p1#2', C)] as [Chunk, Chunk, Chunk];
  const shown = new Map([ca, cb].map((c) => [c.id, c]));
  const snaps = new Map([['paper', source().snapshot]]);
  const item = std('construct-validity').groups[0]!.items[0]!;
  const check = (excerpt: string, quote: string) => finalize(std('construct-validity'), item, { value: 'met', rationale: 'r', evidence: [{ excerpt, quote }] }, shown, snaps);
  const kept = (r: ReturnType<typeof check>) => r.check.quotes_kept;

  it('accepts a bracketed excerpt id', () => {
    expect(kept(check('[paper:p1#0]', '817 questions spanning 38 categories'))).toBe(1);
    expect(kept(check(' [paper:p1#0] ', '817 questions spanning 38 categories'))).toBe(1);
  });
  it('accepts a quote from another chunk shown in the group, and reports that chunk', () => {
    const r = check('paper:p1#0', 'We report 95% confidence intervals for all primary scores');
    expect(kept(r)).toBe(1);
    expect(r.verdict!.evidence[0]!.locator).toBe('loc paper:p1#1');
  });
  it('rejects a quote found only in a chunk that was not shown', () => {
    const r = check('paper:p1#0', 'the questions are in English only');
    expect(kept(r)).toBe(0);
    expect(r.verdict!.value).toBe('unmet');
    expect(cc.text).toContain('English only');
  });
  it('accepts ellipsis-joined parts in order within one chunk, with "..." or "…"', () => {
    expect(kept(check('paper:p1#0', '817 questions spanning 38 categories ... Scores are averaged over five runs'))).toBe(1);
    expect(kept(check('paper:p1#0', '817 questions spanning 38 categories… Scores are averaged over five runs'))).toBe(1);
  });
  it('rejects ellipsis parts out of order, spread over two chunks, or shorter than 12 characters', () => {
    expect(kept(check('paper:p1#0', 'Scores are averaged over five runs ... 817 questions spanning 38 categories'))).toBe(0);
    expect(kept(check('paper:p1#0', '817 questions spanning 38 categories ... bootstrap resampling is used'))).toBe(0);
    expect(kept(check('paper:p1#0', '817 questions spanning 38 categories ... law'))).toBe(0);
  });
  it('still rejects a fabricated quote', () => {
    expect(kept(check('paper:p1#0', 'The benchmark contains 900 questions in total'))).toBe(0);
  });
});

describe('automated assessor', () => {
  it('keeps verified quotes and marks verdicts as model-made', async () => {
    const r = await run('construct-validity', (items, ex) => ({
      verdicts: items.map((id) => id === 'st.2'
        ? { item: id, value: 'met', rationale: 'CIs are reported.', evidence: [{ excerpt: ex.find((e) => e) , quote: 'We report 95% confidence intervals for all primary scores' }] }
        : { item: id, value: 'unmet', rationale: 'Not documented.', evidence: [] }),
    }));
    // The quote is only kept if the cited excerpt really contains it; find which excerpt that is.
    const st2 = r.assessment.verdicts!['st.2']!;
    expect(st2.by).toBe('model');
    expect(r.assessment.model_run!.prompt_version).toBe('1');
    expect(r.assessment.model_run!.excerpt_chars).toBe(10_000);
    expect(r.transcript.length).toBe(std('construct-validity').groups.length);
    expect(['met', 'unmet']).toContain(st2.value);
  });

  it('downgrades a positive verdict whose quote is not in the cited excerpt', async () => {
    const r = await run('construct-validity', (items, ex) => ({
      verdicts: items.map((id) => ({ item: id, value: 'met', rationale: 'Looks fine.', evidence: [{ excerpt: ex[0], quote: 'a sentence that appears nowhere in the paper' }] })),
    }));
    const all = Object.values(r.assessment.verdicts!);
    expect(all.every((v) => v.value === 'unmet')).toBe(true);
    expect(all[0]!.rationale).toMatch(/could be verified/);
    expect(r.transcript[0]!.checks[0]!.note).toBe('downgraded: no quote could be verified');
  });

  it('finds a quote in whichever shown excerpt holds it, whichever excerpt is cited', async () => {
    const r = await run('construct-validity', (items, ex) => ({
      verdicts: items.map((id) => ({ item: id, value: 'met', rationale: 'x', evidence: [{ excerpt: ex[0], quote: 'We report 95% confidence intervals for all primary scores' }] })),
    }));
    const st2 = r.assessment.verdicts!['st.2']!;
    expect(st2.value).toBe('met');
    expect(st2.evidence.length).toBe(1);
    expect(st2.evidence[0]!.url).toBe('https://arxiv.org/abs/2109.07958v2');
  });

  it('rejects n/a on items without an n/a condition', async () => {
    const r = await run('construct-validity', (items) => ({ verdicts: items.map((id) => ({ item: id, value: 'n/a', rationale: 'skip' })) }));
    expect(r.assessment.verdicts!['def.1']!.value).toBe('unmet');
    expect(r.assessment.verdicts!['st.3']!.value).toBe('n/a');
  });

  it('maps points levels and downgrades unsupported levels to 0', async () => {
    const r = await run('betterbench', (items) => ({ verdicts: items.map((id) => ({ item: id, value: 15, rationale: 'x', evidence: [] })) }));
    expect(Object.values(r.assessment.verdicts!).every((v) => v.value === 0)).toBe(true);
  });

  describe('schema-constrained retry', () => {
    const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    const goodObj = (items: string[]) => JSON.stringify({ verdicts: Object.fromEntries(items.map((id) => [id, { value: 'unmet', rationale: 'x', evidence: [] }])) });
    const good = (items: string[]) => JSON.stringify({ verdicts: items.map((id) => ({ item: id, value: 'unmet', rationale: 'x', evidence: [] })) });
    /** Runs the first group of construct-validity only. */
    const go = (handler: (body: any, n: number) => Response, constrainedRetry?: boolean) => {
      const bodies: any[] = [];
      const f: typeof fetch = async (_u, init) => { const b = JSON.parse(String(init!.body)); bodies.push(b); return handler(b, bodies.length); };
      const g = std('construct-validity').groups[0]!;
      return assess({
        benchmark: bench('truthfulqa'), standard: { ...std('construct-validity'), groups: [g] }, sources: [source()],
        llm: { baseUrl: 'http://fake', model: 'm', temperature: 0, seed: 1, maxTokens: 100 },
        provider: 'p', license: 'l', runOn: '2026-10-29', transcriptPath: 'x.jsonl', pins: {}, fetchImpl: f, constrainedRetry,
      }).then((r) => ({ ...r, bodies, ids: g.items.map((i) => i.id) }));
    };
    const ids = (b: any): string[] => [...b.messages[0].content.matchAll(/^- id: (\S+)/gm)].map((m: RegExpMatchArray) => m[1]!);

    it('retries a malformed reply once with json_schema and uses the better reply', async () => {
      const r = await go((b, n) => reply(n === 1
        ? JSON.stringify({ verdicts: [{ item: ids(b)[0], value: 'unmet', rationale: 'x', evidence: [] }], [ids(b)[1]!]: { value: 'unmet' } })
        : goodObj(ids(b))));
      expect(r.ids.length).toBeGreaterThan(1);
      expect(r.bodies).toHaveLength(2);
      expect(r.bodies[0].response_format.type).toBe('json_object');
      const rf = r.bodies[1].response_format;
      expect(rf.type).toBe('json_schema');
      expect(rf.json_schema.strict).toBe(true);
      const vs = rf.json_schema.schema.properties.verdicts;
      expect(vs.required).toEqual(r.ids);
      expect(Object.keys(vs.properties)).toEqual(r.ids);
      expect(vs.additionalProperties).toBe(false);
      expect(vs.properties[r.ids[0]!].required).toEqual(['value', 'rationale', 'evidence']);
      expect(r.bodies[1].messages).toEqual(r.bodies[0].messages);
      expect(r.calls).toBe(2);
      expect(r.complete).toBe(true);
      expect(r.transcript.map((t) => t.constrained)).toEqual([undefined, 'json_schema']);
      expect(r.transcript.map((t) => t.checks.length)).toEqual([0, r.ids.length]);
      expect(Object.keys(r.assessment.verdicts!).sort()).toEqual([...r.ids].sort());
    });
    it('converts an object-form constrained reply and completes the group', async () => {
      const r = await go((b, n) => reply(n === 1 ? '{"verdicts": []}' : goodObj(ids(b))));
      expect(r.complete).toBe(true);
      expect(Object.keys(r.assessment.verdicts!).sort()).toEqual([...r.ids].sort());
      expect(r.transcript[1]!.checks).toHaveLength(r.ids.length);
    });
    it('records a 400 on the schema request as an error, without an unconstrained third request', async () => {
      const r = await go((_b, n) => n === 1 ? reply('not json at all') : new Response('bad schema', { status: 400 }));
      expect(r.bodies).toHaveLength(2);
      expect(r.transcript[1]!.error).toMatch(/400/);
      expect(r.complete).toBe(false);
      expect(r.calls).toBe(2);
    });
    it('retries a max_tokens cutoff with json_schema', async () => {
      const cut = `data: ${JSON.stringify({ choices: [{ delta: { content: '{"verdicts": [' }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`;
      const r = await go((b, n) => n === 1 ? new Response(cut, { status: 200 }) : reply(goodObj(ids(b))));
      expect(r.bodies).toHaveLength(2);
      expect(r.complete).toBe(true);
      expect(r.transcript[0]!.error).toMatch(/hit max_tokens/);
      expect(r.transcript.some((t) => t.constrained === 'json_schema')).toBe(true);
      expect(Object.keys(r.assessment.verdicts!).sort()).toEqual([...r.ids].sort());
    });
    it('makes no schema retry when constrainedRetry is false', async () => {
      const r = await go(() => reply('not json at all'), false);
      expect(r.bodies).toHaveLength(1);
      expect(r.calls).toBe(1);
    });
    it('does not retry a well-formed reply', async () => {
      const r = await go((b) => reply(good(ids(b))));
      expect(r.bodies).toHaveLength(1);
      expect(r.bodies[0].response_format.type).toBe('json_object');
      expect(r.transcript[0]!.constrained).toBeUndefined();
    });
  });

  it('stops at the call budget and marks the run partial', async () => {
    const r = await run('aisl-scorecard', (items) => ({ verdicts: items.map((id) => ({ item: id, value: 'unmet', rationale: 'x' })) }), 2);
    expect(r.calls).toBe(2);
    expect(r.complete).toBe(false);
  });

  it('builds the same prompt for the same sources', async () => {
    const a = await run('abc', () => ({ verdicts: [] }));
    const b = await run('abc', () => ({ verdicts: [] }));
    expect(a.prompts).toEqual(b.prompts);
    expect(a.transcript.map((e) => e.prompt_sha256)).toEqual(b.transcript.map((e) => e.prompt_sha256));
    const g = std('abc').groups[0]!;
    expect(selectExcerpts(g, source().chunks).map((c) => c.id)).toEqual(a.transcript[0]!.excerpts);
  });

  it('selects more chunks under a larger excerpt budget', () => {
    const g = std('abc').groups[0]!;
    const text = g.items.map((i) => i.text).join(' ');
    // 3000-char chunks that all match the group, so the 10,000 default keeps 3 and 40,000 keeps more
    const chunks = Array.from({ length: 8 }, (_, i) => ({ id: `paper:p#${i}`, source: 'paper:p', locator: 'p', text: `${text} ${'x'.repeat(3000 - text.length - 1)}` }));
    expect(selectExcerpts(g, chunks)).toHaveLength(3);
    expect(selectExcerpts(g, chunks, 40_000).length).toBeGreaterThan(3);
  });

  it('produces an assessment that validates as a draft and scores', async () => {
    const r = await run('aisl-scorecard', (items) => ({ verdicts: items.map((id) => ({ item: id, value: 'unmet', rationale: 'Not documented.' })) }));
    const path = 'data/assessments/truthfulqa/aisl-scorecard.auto.yaml';
    const errors = validate({ ...corpus, assessments: [...corpus.assessments, { path, value: r.assessment }] });
    expect(errors).toEqual([]);
    expect(score(std('aisl-scorecard'), r.assessment).overall.label).toBe('Unclassified');
  });
});

describe('watch queue', () => {
  it('queues every in-scope pair for a benchmark with sources and orders it deterministically', () => {
    const q = queue(corpus, { checked_on: '2026-10-26', benchmarks: { truthfulqa: { paper_version: 'v2', repo_commit: 'abc' }, cybench: { paper_version: 'v4' } } });
    expect(q.filter((x) => x.benchmark === 'truthfulqa').map((x) => x.standard)).toEqual(['aisl-scorecard', 'betterbench', 'construct-validity', 'deprecating-benchmarks', 'eu-gpai-code-of-practice', 'nist-ai-800-2', 'stream', 'yu-safety-benchmarks']);
    expect(q.filter((x) => x.benchmark === 'cybench').map((x) => x.standard)).toContain('abc');
    expect(q.some((x) => x.benchmark === 'truthfulqa' && x.standard === 'abc')).toBe(false);
  });
});

describe('correction triage', () => {
  const body = (b: string, s: string, items: string, evidence = 'https://arxiv.org/abs/2109.07958v2 section 3') =>
    `### Benchmark\n\n${b}\n\n### Standard\n\n${s}\n\n### Items\n\n${items}\n\n### What is wrong\n\nx\n\n### Evidence\n\n${evidence}\n`;

  it('parses issue form sections', () => {
    expect(parseIssueForm(body('truthfulqa', 'betterbench', 'des.01'))['Items']).toBe('des.01');
  });
  it('quotes the current verdict for a valid request', () => {
    const r = triage(corpus, body('truthfulqa', 'betterbench', 'des.01'));
    expect(r.ok).toBe(true);
    expect(r.comment).toContain('des.01');
    expect(r.labels).toContain('triaged');
  });
  it('asks for fixes when ids are unknown or evidence is missing', () => {
    const r = triage(corpus, body('nope', 'betterbench', 'zzz', '_No response_'));
    expect(r.ok).toBe(false);
    expect(r.comment).toMatch(/No benchmark matches/);
    expect(r.comment).toMatch(/Please add evidence/);
  });
  it('neutralises markup and mentions echoed from the issue', () => {
    const r = triage(corpus, body('<img src=x> @someone', 'betterbench', 'des.01'));
    expect(r.comment).not.toContain('<img');
    expect(r.comment).not.toContain('@someone');
  });
});

describe('streaming chat client', () => {
  const sse = (events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  const cfg = { baseUrl: 'http://fake', model: 'm', temperature: 0, seed: 1, maxTokens: 10 };
  it('assembles content and reasoning from a stream', async () => {
    const { chat } = await import('../src/assess/llm.ts');
    const body = sse([{ choices: [{ delta: { reasoning: 'thinking ' } }] }, { choices: [{ delta: { content: '{"verdicts":' } }] }, { choices: [{ delta: { content: '[]}' }, finish_reason: 'stop' }] }]);
    const r = await chat(cfg, [{ role: 'user', content: 'x' }], async () => new Response(body, { status: 200 }));
    expect(r.content).toBe('{"verdicts":[]}');
    expect(r.reasoning).toBe('thinking ');
  });
  it('recognises a stream that opens with SSE comment lines (OpenRouter)', async () => {
    const { chat } = await import('../src/assess/llm.ts');
    const body = ': OPENROUTER PROCESSING\n\n' + sse([{ provider: 'DeepInfra', choices: [{ delta: { content: '{"verdicts":[]}' }, finish_reason: 'stop' }] }]);
    const r = await chat(cfg, [{ role: 'user', content: 'x' }], async () => new Response(body, { status: 200 }));
    expect(r).toMatchObject({ content: '{"verdicts":[]}', provider: 'DeepInfra' });
  });
  it('captures the served model from a stream chunk and from a plain JSON reply', async () => {
    const { chat } = await import('../src/assess/llm.ts');
    const body = sse([{ choices: [{ delta: { content: '{}' } }] }, { model: 'google/gemma-4-31B-it', choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    expect((await chat(cfg, [{ role: 'user', content: 'x' }], async () => new Response(body, { status: 200 }))).served_model).toBe('google/gemma-4-31B-it');
    const json = JSON.stringify({ model: 'x/y', choices: [{ message: { content: '{}' } }] });
    expect((await chat(cfg, [{ role: 'user', content: 'x' }], async () => new Response(json, { status: 200 }))).served_model).toBe('x/y');
  });
  it('treats a truncated stream as a failure', async () => {
    const { chat } = await import('../src/assess/llm.ts');
    const body = sse([{ choices: [{ delta: { content: '{"verdicts": [' }, finish_reason: 'length' }] }]);
    await expect(chat(cfg, [{ role: 'user', content: 'x' }], async () => new Response(body, { status: 200 }))).rejects.toThrow(/max_tokens/);
  });
  it('rejects a non-completion 200 such as a retired endpoint', async () => {
    const { chat } = await import('../src/assess/llm.ts');
    await expect(chat(cfg, [{ role: 'user', content: 'x' }], async () => new Response('OK\r\n', { status: 200 }))).rejects.toThrow(/did not return a chat completion/);
  });
});

describe('per-model request settings', () => {
  it('merges extra into the body (not model/messages) and returns the streamed provider', async () => {
    const { chat } = await import('../src/assess/llm.ts');
    let seen: Record<string, unknown> = {};
    const f = async (_u: unknown, init?: RequestInit) => {
      seen = JSON.parse(String(init!.body));
      const ev = [{ provider: 'DeepInfra', choices: [{ delta: { content: '{}' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }];
      return new Response(ev.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200 });
    };
    const extra = { provider: { only: ['deepinfra'] }, seed: 7, model: 'evil', messages: [] };
    const r = await chat({ baseUrl: 'http://fake', model: 'm', temperature: 0, seed: 1, maxTokens: 10, extra }, [{ role: 'user', content: 'x' }], f as typeof fetch);
    expect(seen.provider).toEqual({ only: ['deepinfra'] });
    expect(seen.seed).toBe(7);
    expect(seen.model).toBe('m');
    expect(seen.messages).toHaveLength(1);
    expect(r.provider).toBe('DeepInfra');
  });
});

describe('thinking switch', () => {
  it('sends think:false and /no_think when thinking is off, and nothing extra otherwise', async () => {
    const { chat } = await import('../src/assess/llm.ts');
    const seen: Record<string, unknown>[] = [];
    const f = async (_u: unknown, init?: RequestInit) => {
      seen.push(JSON.parse(String(init!.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
    };
    const base = { baseUrl: 'http://fake', model: 'qwen3:8b', temperature: 0, seed: 1, maxTokens: 10 };
    await chat({ ...base, think: false }, [{ role: 'user', content: 'Assess this.' }], f as typeof fetch);
    await chat(base, [{ role: 'user', content: 'Assess this.' }], f as typeof fetch);
    expect(seen[0]!.think).toBe(false);
    expect((seen[0]!.messages as { content: string }[])[0]!.content).toBe('Assess this.\n\n/no_think');
    expect(seen[1]!.think).toBeUndefined();
    expect((seen[1]!.messages as { content: string }[])[0]!.content).toBe('Assess this.');
  });
});

describe('parseJson', () => {
  const obj = { verdicts: [{ item: 'a', rationale: 'see\n```py\nx = 1\n```\nok' }] };
  it('parses valid JSON whose string contains a code fence', () => {
    expect(parseJson(JSON.stringify(obj))).toEqual(obj);
  });
  it('parses a reply wrapped in a json fence', () => {
    expect(parseJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });
  it('parses prose followed by fenced JSON', () => {
    expect(parseJson('Here you go:\n```json\n{"a": {"b": 2}}\n```\nDone {not json}')).toEqual({ a: { b: 2 } });
  });
  it('throws on garbage', () => {
    expect(() => parseJson('no json here')).toThrow('no JSON object in reply');
    expect(() => parseJson('{broken')).toThrow();
  });
});

describe('recordedOn (assess resume)', () => {
  it('skips only a file assessed on the run date', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-'));
    const f = join(dir, 'x.auto.yaml');
    writeFileSync(f, '# note\nprovenance:\n  assessed_on: 2026-10-29\n');
    expect(recordedOn(f, '2026-10-29')).toBe(true);
    expect(recordedOn(f, '2026-10-30')).toBe(false);
    expect(recordedOn(join(dir, 'missing.yaml'), '2026-10-29')).toBe(false);
  });
});
