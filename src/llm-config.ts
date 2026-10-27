import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Corpus } from './load.ts';

/** Config for any allowlisted model: endpoint, key (read from the env var the entry names, never logged) and request extras. */
export function llmConfig(c: Corpus, modelOverride?: string) {
  const cfg = parse(readFileSync(join(c.root, 'config/models.yaml'), 'utf8')) as { default: string };
  const model = modelOverride || process.env.TOUCHSTONE_MODEL || cfg.default;
  const entry = c.models.find((m) => m.id === model);
  if (!entry) throw new Error(`Model "${model}" is not on the open-weights allowlist in config/models.yaml.`);
  // An entry's own base_url wins; the env override only applies to entries without one, so a bake-off never
  // sends every model (and its key) to the host the variable names. Default: a local Ollama server.
  const baseUrl = entry.base_url || process.env.TOUCHSTONE_LLM_BASE_URL || 'http://localhost:11434/v1';
  // A key is sent only to a hosted endpoint (entry base_url / api_key_env, or an explicit env override), never to local Ollama.
  const keyEnv = entry.base_url || entry.api_key_env || process.env.TOUCHSTONE_LLM_BASE_URL ? entry.api_key_env ?? 'TOUCHSTONE_LLM_API_KEY' : undefined;
  const apiKey = keyEnv ? process.env[keyEnv] || undefined : undefined;
  // A `request` block is the source of truth for hosted models; the old defaults apply to Ollama entries only.
  const defaults = !entry.request;
  const effort = process.env.TOUCHSTONE_REASONING_EFFORT || (defaults && model.includes('gpt-oss') ? 'low' : '');
  // qwen3 on a CPU runner spent its whole budget thinking and never answered; the answer's per-item
  // rationale is the reasoning we keep. TOUCHSTONE_THINK=on turns thinking back on.
  const think = process.env.TOUCHSTONE_THINK ? process.env.TOUCHSTONE_THINK === 'on' : defaults && model.startsWith('qwen3') ? false : undefined;
  return {
    entry,
    /** Name of the env var holding the key this model needs, if any (never its value). */
    keyEnv,
    llm: {
      baseUrl,
      apiKey,
      model, temperature: 0, seed: 20261026, maxTokens: 6000,
      ...(effort ? { reasoningEffort: effort as 'low' | 'medium' | 'high' } : {}),
      ...(think !== undefined ? { think } : {}),
      ...(entry.request ? { extra: entry.request } : {}),
    },
  };
}
