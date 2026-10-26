/**
 * Minimal client for any OpenAI-compatible chat endpoint (GitHub Models, Ollama, vLLM, llama.cpp).
 * Requests are pinned to temperature 0 and a fixed seed. Hosted models are still not guaranteed to
 * be bit-for-bit repeatable, which is why every response is stored verbatim in the run transcript.
 */
export interface LlmConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature: number;
  seed: number;
  maxTokens: number;
}

export interface ChatResult {
  content: string;
  /** Reasoning text, when the model or provider returns it separately (gpt-oss does). */
  reasoning?: string;
  usage?: unknown;
}

export class RateLimited extends Error {}

export async function chat(cfg: LlmConfig, messages: { role: 'system' | 'user'; content: string }[], f: typeof fetch = fetch): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: cfg.model, messages, temperature: cfg.temperature, seed: cfg.seed, max_tokens: cfg.maxTokens,
    response_format: { type: 'json_object' },
  };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const url = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  let res = await f(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (res.status === 400) {
    // Some servers reject response_format; the prompt already asks for JSON only.
    delete body.response_format;
    res = await f(url, { method: 'POST', headers, body: JSON.stringify(body) });
  }
  if (res.status === 429) throw new RateLimited(`rate limited by ${cfg.baseUrl}`);
  if (!res.ok) throw new Error(`${cfg.baseUrl} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const d = (await res.json()) as { choices?: { message?: { content?: string; reasoning_content?: string; reasoning?: string } }[]; usage?: unknown };
  const m = d.choices?.[0]?.message;
  if (!m?.content) throw new Error(`${cfg.baseUrl} returned no message content`);
  return { content: m.content, reasoning: m.reasoning_content ?? m.reasoning, usage: d.usage };
}

/** Pull the JSON object out of a reply, tolerating a ```json fence. */
export function parseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const s = (fenced ? fenced[1]! : text).trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in reply');
  return JSON.parse(s.slice(start, end + 1));
}
