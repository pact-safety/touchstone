import { z } from 'zod';

/** Lowercase-led identifier; dots allowed so item ids can mirror a standard's numbering (cv.01, T.10). */
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'ids use letters, digits, ".", "_" and "-"');
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'slugs are lowercase letters, digits and "-"');
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dates are YYYY-MM-DD');

export const EvidenceSource = z.enum(['paper', 'repo', 'docs', 'website', 'dataset', 'report']);

export const Severity = z.enum(['baseline', 'yellow', 'orange', 'red']);

export const Item = z.strictObject({
  id: Id,
  /** The standard's own wording, verbatim. */
  text: z.string().min(1),
  /** The principle a leaf item sits under, shown to assessors as context. Not scored. */
  principle: z.string().optional(),
  /** Other wordings of this item found in the standard's published assessments. */
  aliases: z.array(z.string()).optional(),
  /** AISL severity: unmet baseline items invalidate a dimension; colours cap its score. */
  severity: Severity.optional(),
  guidance: z
    .strictObject({
      /** Decision rule: the item is met when this is true of the evidence. */
      met: z.string().min(1),
      /** When true of the benchmark, the item is not applicable. Absent means never n/a. */
      not_applicable: z.string().optional(),
      evidence: z.array(EvidenceSource).min(1),
      /** Name of an automated repo probe that can supply evidence for this item. */
      probe: z.string().optional(),
    })
    .optional(),
});
export type Item = z.infer<typeof Item>;

export const Group = z.strictObject({
  id: Id,
  name: z.string(),
  description: z.string().optional(),
  items: z.array(Item),
});
export type Group = z.infer<typeof Group>;

const AislCategory = z.strictObject({
  id: z.string(),
  use: z.string(),
  /** Worst (highest) score each dimension may have for this category. */
  max: z.record(z.string(), z.number().int().min(1).max(4)),
});

export const Scoring = z.discriminatedUnion('scheme', [
  z.strictObject({
    scheme: z.literal('aisl-severity'),
    severity_scores: z.strictObject({ yellow: z.number(), orange: z.number(), red: z.number() }),
    /** Ordered best first; an assessment gets the first category it satisfies. */
    categories: z.array(AislCategory).min(1),
  }),
  z.strictObject({
    scheme: z.literal('points'),
    levels: z.array(z.number()).min(2),
    max: z.number().positive(),
    level_meanings: z.record(z.string(), z.string()).optional(),
    /** Stage score = mean of applicable item levels. Overall = mean of all applicable item levels. */
    overall: z.literal('mean-of-items'),
  }),
  z.strictObject({
    scheme: z.literal('checklist'),
    /** Group score = met / (met + unmet) × 100. Overall = mean of group scores. */
    overall: z.literal('mean-of-groups'),
  }),
]);
export type Scoring = z.infer<typeof Scoring>;

export const Standard = z
  .strictObject({
    id: Slug,
    name: z.string(),
    short: z.string(),
    version: z.string(),
    publisher: z.string(),
    year: z.number().int(),
    kind: z.enum(['rubric', 'checklist', 'reporting-standard', 'government-guidance', 'regulatory-code', 'formal-standard', 'lifecycle-criteria']),
    /** encoded: items and scoring are machine-readable. catalogued: tracked, not yet encoded. */
    status: z.enum(['encoded', 'catalogued']),
    /** Set when the standard publishes no scoring rule and Touchstone supplies one. */
    scoring_defined_by: z.literal('touchstone').optional(),
    applies_to: z.string().optional(),
    /** Which benchmarks the automated assessor applies this standard to. Absent means all. */
    scope: z
      .strictObject({
        modalities: z.array(z.string()).optional(),
        domains: z.array(z.enum(['safety', 'capability'])).optional(),
      })
      .optional(),
    url: z.string().url(),
    citation: z.string().optional(),
    description: z.string(),
    notes: z.string().optional(),
    scoring: Scoring.optional(),
    groups: z.array(Group),
  })
  .superRefine((s, ctx) => {
    if (s.status === 'encoded') {
      if (!s.scoring) ctx.addIssue({ code: 'custom', message: 'an encoded standard needs scoring' });
      if (s.groups.length === 0) ctx.addIssue({ code: 'custom', message: 'an encoded standard needs groups' });
    }
    const ids = s.groups.flatMap((g) => g.items.map((i) => i.id));
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) ctx.addIssue({ code: 'custom', message: `duplicate item id ${dup}` });
    if (s.scoring?.scheme === 'aisl-severity') {
      for (const g of s.groups)
        for (const it of g.items)
          if (!it.severity) ctx.addIssue({ code: 'custom', message: `${it.id} needs a severity under aisl-severity` });
      for (const c of s.scoring.categories)
        for (const g of s.groups)
          if (!(g.id in c.max)) ctx.addIssue({ code: 'custom', message: `category ${c.id} has no limit for ${g.id}` });
    }
  });
export type Standard = z.infer<typeof Standard>;

const Citation = z.strictObject({ url: z.string().url(), locator: z.string().min(1) });

/**
 * What a full run of the benchmark costs, for the run-cost half of the Touchstone score.
 * Counts come from the benchmark's own paper, docs or repo (cited); `tokens_per_call` is an
 * estimate whose basis must be stated. See docs/touchstone-score.md.
 */
export const Resources = z.strictObject({
  /** Test items in the standard full evaluation (not train/dev splits). */
  items: z.number().int().positive(),
  /**
   * single-turn: one prompt, one answer. multi-turn: a scripted conversation. agentic: the model acts in an
   * environment. non-llm: evaluates a trained policy or classifier, so cost is compute, not tokens.
   */
  interaction: z.enum(['single-turn', 'multi-turn', 'agentic', 'non-llm']),
  /** Mean calls to the model under test per item (1 for single-turn; for agentic, the stated or default step limit). */
  model_calls_per_item: z.number().nonnegative(),
  /** Mean input + output tokens per model call. An estimate: say how it was made in `estimate_basis`. */
  tokens_per_call: z.number().int().nonnegative(),
  /** How outputs are scored. */
  grading: z.enum(['exact', 'rule-based', 'execution', 'llm-judge', 'human']),
  /** Mean grader-model calls per item (0 unless grading is llm-judge). */
  judge_calls_per_item: z.number().nonnegative(),
  /** What the harness needs beyond access to the model under test. */
  environment: z.enum(['none', 'python', 'docker', 'vm', 'simulator', 'live-web']),
  /** The harness itself needs a GPU (independent of hosting the model under test). */
  gpu_required: z.boolean(),
  /** Download size of data, images and environments for a full run, in GB. */
  disk_gb: z.number().nonnegative(),
  estimate_basis: z.string().min(1),
  sources: z.array(Citation).min(1),
}).superRefine((r, ctx) => {
  const llm = r.interaction !== 'non-llm';
  if (llm && (r.model_calls_per_item <= 0 || r.tokens_per_call <= 0))
    ctx.addIssue({ code: 'custom', message: 'language-model benchmarks need model_calls_per_item and tokens_per_call above 0' });
  if (!llm && (r.model_calls_per_item !== 0 || r.tokens_per_call !== 0 || r.judge_calls_per_item !== 0))
    ctx.addIssue({ code: 'custom', message: 'non-llm benchmarks have 0 model calls, tokens and judge calls' });
  if (r.grading !== 'llm-judge' && r.judge_calls_per_item !== 0)
    ctx.addIssue({ code: 'custom', message: 'judge_calls_per_item must be 0 unless grading is llm-judge' });
});
export type Resources = z.infer<typeof Resources>;

export const Benchmark = z.strictObject({
  id: Slug,
  name: z.string(),
  domain: z.enum(['safety', 'capability']),
  modality: z.enum(['language-model', 'lm-agent', 'rl-agent', 'classifier', 'scientific-ml']),
  concept: z.string(),
  year: z.number().int().optional(),
  links: z
    .strictObject({
      paper: z.string().url().optional(),
      repo: z.string().url().optional(),
      website: z.string().url().optional(),
    })
    .default({}),
  resources: Resources.optional(),
});
export type Benchmark = z.infer<typeof Benchmark>;

export const Evidence = z.strictObject({
  source: EvidenceSource,
  url: z.string().url(),
  /** Where in the source: section, page, table, or file path with line range at a commit. */
  locator: z.string().min(1),
  /** A short excerpt (keep under ~50 words; quote, don't reproduce). */
  quote: z.string().max(400).optional(),
  note: z.string().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

export const Verdict = z.strictObject({
  /** 'met' | 'unmet' | 'n/a' for checklist and AISL items; a level from `levels` or 'n/a' for points items. */
  value: z.union([z.enum(['met', 'unmet', 'n/a']), z.number()]),
  /** Why the decision rule is or isn't satisfied, in the assessor's (or model's) words. */
  rationale: z.string().optional(),
  evidence: z.array(Evidence).default([]),
  /** Who decided: a model proposal, or a human (an original call or an override of the model). */
  by: z.enum(['model', 'human']).optional(),
  /** Set by the assessor: every quote was found verbatim in the fetched source at its pinned version. */
  quotes_verified: z.boolean().optional(),
});
export type Verdict = z.infer<typeof Verdict>;

export const Revision = z.strictObject({
  date: IsoDate,
  by: z.string(),
  summary: z.string(),
  /** Item or group ids whose verdict or score changed in this revision. */
  items: z.array(z.string()).optional(),
  /** Issue number of the correction request this revision answers. */
  request: z.number().int().positive().optional(),
});
export type Revision = z.infer<typeof Revision>;

export const SourceSnapshot = z.strictObject({
  kind: z.enum(['paper', 'repo', 'docs', 'website', 'dataset']),
  url: z.string().url(),
  /** Immutable reference: arXiv version (v2), git commit SHA, or dataset revision. */
  ref: z.string(),
  /** sha256 of the text the model was given, so a re-fetch can be checked against it. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  chars: z.number().int().nonnegative(),
});
export type SourceSnapshot = z.infer<typeof SourceSnapshot>;

export const ModelRun = z.strictObject({
  /** Model identifier as the provider names it. Must be on config/models.yaml's open-weights allowlist. */
  model: z.string(),
  provider: z.string(),
  license: z.string(),
  /** Content digest of the exact weights used, where the server reports one (Ollama does). */
  model_digest: z.string().optional(),
  temperature: z.number(),
  seed: z.number().int(),
  /** Version of prompts/assess-item.md used; bump it whenever the prompt changes. */
  prompt_version: z.string(),
  run_on: IsoDate,
  /** Repo path of the JSONL transcript: every prompt and raw response, in order. */
  transcript: z.string(),
  sources: z.array(SourceSnapshot).min(1),
});
export type ModelRun = z.infer<typeof ModelRun>;

/** A group score as published by an external assessor; 'invalid' marks a dimension that could not be scored. */
const ImportedScore = z.union([z.number(), z.literal('invalid'), z.null()]);

export const Assessment = z
  .strictObject({
    benchmark: Slug,
    standard: Slug,
    standard_version: z.string(),
    status: z.enum(['draft', 'published']),
    /** itemized: a verdict per item, scored by the engine. imported: group scores copied from a published source. */
    mode: z.enum(['itemized', 'imported']),
    provenance: z.strictObject({
      /**
       * touchstone: assessed by people under this repo's process.
       * automated: verdicts proposed by an open-weights model (see model_run), then reviewed by people.
       * external: transcribed from another party's published assessment.
       */
      kind: z.enum(['touchstone', 'automated', 'external']),
      assessors: z.array(z.string()).min(1),
      /** People who reviewed an automated assessment before it was published. */
      reviewers: z.array(z.string()).optional(),
      assessed_on: IsoDate,
      source_title: z.string().optional(),
      source_url: z.string().url().optional(),
      standard_version_used: z.string().optional(),
    }),
    /** What exactly was assessed, so a re-assessment can tell if the benchmark changed. */
    benchmark_ref: z
      .strictObject({
        paper_version: z.string().optional(),
        repo_commit: z.string().optional(),
        dataset_version: z.string().optional(),
      })
      .optional(),
    /** Present on automated assessments: exactly how the model was run, so anyone can audit or repeat it. */
    model_run: ModelRun.optional(),
    verdicts: z.record(z.string(), Verdict).optional(),
    scores: z.record(z.string(), ImportedScore).optional(),
    /** Numbers the source published, kept so the engine can flag where they disagree with a recomputation. */
    published: z
      .strictObject({
        groups: z.record(z.string(), ImportedScore).optional(),
        overall: z.number().optional(),
        label: z.string().optional(),
      })
      .optional(),
    notes: z.string().optional(),
    revisions: z.array(Revision).min(1),
  })
  .superRefine((a, ctx) => {
    if (a.mode === 'itemized' && !a.verdicts) ctx.addIssue({ code: 'custom', message: 'itemized assessments need verdicts' });
    if (a.mode === 'imported' && !a.scores && !a.published?.label)
      ctx.addIssue({ code: 'custom', message: 'imported assessments need scores or a published label' });
    if (a.provenance.kind === 'external' && !a.provenance.source_url)
      ctx.addIssue({ code: 'custom', message: 'external assessments need provenance.source_url' });
    if (a.provenance.kind === 'automated') {
      if (!a.model_run) ctx.addIssue({ code: 'custom', message: 'automated assessments need model_run' });
      if (a.status === 'published' && !a.provenance.reviewers?.length)
        ctx.addIssue({ code: 'custom', message: 'automated assessments need at least one human reviewer before publishing' });
    }
  });
export type Assessment = z.infer<typeof Assessment>;
