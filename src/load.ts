import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { Assessment, Benchmark, Standard } from './schema.ts';

export interface Loaded<T> { path: string; value: T }
export interface Corpus {
  root: string;
  standards: Loaded<Standard>[];
  benchmarks: Loaded<Benchmark>[];
  assessments: Loaded<Assessment>[];
  models: OpenModel[];
  errors: string[];
}

export const OpenModel = z.strictObject({
  id: z.string(),
  provider: z.string(),
  license: z.string(),
  weights: z.string().url(),
  note: z.string().optional(),
  /** Endpoint for this model; TOUCHSTONE_LLM_BASE_URL still overrides it. */
  base_url: z.string().url().optional(),
  /** Name (not value) of the env var holding this endpoint's API key. */
  api_key_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  /** Extra JSON body fields sent with every call, e.g. an OpenRouter provider block. */
  request: z.record(z.string(), z.unknown()).optional(),
});
export type OpenModel = z.infer<typeof OpenModel>;

const yamlFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? yamlFiles(p) : f.endsWith('.yaml') ? [p] : [];
    })
    .sort();
};

function loadAll<T>(root: string, dir: string, schema: z.ZodType<T>, errors: string[]): Loaded<T>[] {
  const out: Loaded<T>[] = [];
  for (const file of yamlFiles(join(root, dir))) {
    const path = relative(root, file);
    let raw: unknown;
    try {
      raw = parse(readFileSync(file, 'utf8'));
    } catch (e) {
      errors.push(`${path}: YAML does not parse: ${(e as Error).message}`);
      continue;
    }
    const r = schema.safeParse(raw);
    if (!r.success) {
      for (const issue of r.error.issues) errors.push(`${path}: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      continue;
    }
    out.push({ path, value: r.data });
  }
  return out;
}

export function load(root: string): Corpus {
  const errors: string[] = [];
  const standards = loadAll(root, 'standards', Standard, errors);
  const benchmarks = loadAll(root, 'data/benchmarks', Benchmark, errors);
  const assessments = loadAll(root, 'data/assessments', Assessment, errors);
  let models: OpenModel[] = [];
  const modelsPath = join(root, 'config/models.yaml');
  if (existsSync(modelsPath)) {
    const r = z.object({ allowed: z.array(OpenModel) }).safeParse(parse(readFileSync(modelsPath, 'utf8')));
    if (r.success) models = r.data.allowed;
    else errors.push('config/models.yaml: ' + r.error.issues.map((i) => i.message).join('; '));
  }
  return { root, standards, benchmarks, assessments, models, errors };
}

export const fileId = (path: string) => basename(path, '.yaml');
