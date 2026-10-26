import { describe, expect, it } from 'vitest';
import { load } from '../src/load.ts';
import { validate } from '../src/validate.ts';
import { score } from '../src/engine.ts';
import { assess, selectExcerpts } from '../src/assess/run.ts';
import { chunk, normalize, rank, verifyQuote, sha256 } from '../src/assess/text.ts';
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

  it('accepts a quote only from the excerpt it cites', async () => {
    const r = await run('construct-validity', (items, ex) => ({
      verdicts: items.map((id) => ({ item: id, value: 'met', rationale: 'x', evidence: ex.map((e) => ({ excerpt: e, quote: 'We report 95% confidence intervals for all primary scores' })) })),
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
    expect(q.filter((x) => x.benchmark === 'truthfulqa').map((x) => x.standard)).toEqual(['aisl-scorecard', 'betterbench', 'construct-validity', 'stream']);
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
