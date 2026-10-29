/**
 * Minimal client for any OpenAI-compatible chat endpoint (Ollama, vLLM, llama.cpp, OpenRouter, Groq).
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
  /** gpt-oss reasoning effort; omitted for models that don't take it. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /**
   * false turns off a hybrid model's thinking mode (qwen3), so its whole token budget goes to the answer.
   * Sent as Ollama's `think: false` and as Qwen's documented `/no_think` switch at the end of the prompt.
   */
  think?: boolean;
  /** Extra JSON body fields from the model's `request` entry (e.g. OpenRouter `provider`); win over defaults except model/messages. */
  extra?: Record<string, unknown>;
}

export interface ChatResult {
  content: string;
  /** Reasoning text, when the model or provider returns it separately (gpt-oss does). */
  reasoning?: string;
  usage?: unknown;
  /** The upstream provider that served the call, when the router reports one (OpenRouter does). */
  provider?: string;
  /** The model the endpoint says it ran (response `model`); can differ from the one requested. */
  served_model?: string;
  /** Billable requests made: 2 when a 400 forced a retry without response_format. */
  attempts: number;
}

export class RateLimited extends Error {}

/** Longest a single model call may take. CPU-only inference can be silent for many minutes before its first token. */
export const CALL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * POST with node:http(s) rather than fetch: fetch drops a connection after 300 s without response headers or
 * without a new chunk, which a CPU-only model hits while it reads a long prompt. Only the overall cap applies.
 */
async function post(url: string, headers: Record<string, string>, body: string): Promise<Response> {
  const { request } = await import(url.startsWith('https:') ? 'node:https' : 'node:http');
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } }, (res: import('node:http').IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0 })));
      res.on('error', reject);
    });
    req.setTimeout(CALL_TIMEOUT_MS, () => req.destroy(new Error(`no complete response within ${CALL_TIMEOUT_MS / 60000} minutes`)));
    req.on('error', reject);
    req.end(body);
  });
}

/** Name the underlying network error (e.g. ECONNREFUSED) instead of a bare "fetch failed". */
const describe = (e: unknown) => {
  const err = e as Error & { cause?: { code?: string; message?: string }; code?: string };
  const code = err.code ?? err.cause?.code;
  return `${err.message}${code ? ` (${code})` : ''}${err.cause?.message && err.cause.message !== err.message ? `: ${err.cause.message}` : ''}`;
};

type Messages = { role: 'system' | 'user'; content: string }[];

/** A failed call still reports how many requests it made, on `error.attempts`. */
export async function chat(cfg: LlmConfig, messages: Messages, f?: typeof fetch, schema?: object): Promise<ChatResult> {
  const count = { n: 1 };
  try { return { ...(await chatOnce(cfg, messages, f, count, schema)), attempts: count.n }; } catch (e) { throw Object.assign(e as Error, { attempts: count.n }); }
}

async function chatOnce(cfg: LlmConfig, messages: Messages, f: typeof fetch | undefined, count: { n: number }, schema?: object): Promise<Omit<ChatResult, 'attempts'>> {
  // Streamed, so response headers arrive at once: a CPU-only model can take longer than fetch's
  // 300-second header timeout to finish an answer.
  const body: Record<string, unknown> = {
    model: cfg.model, messages, temperature: cfg.temperature, seed: cfg.seed, max_tokens: cfg.maxTokens,
    response_format: { type: 'json_object' }, stream: true,
  };
  if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
  for (const [k, v] of Object.entries(cfg.extra ?? {})) if (k !== 'model' && k !== 'messages') body[k] = v;
  // Schema-constrained decoding is the whole point of that request, so it wins over `extra`.
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'verdicts', strict: true, schema } };
  if (cfg.think === false) {
    body.think = false;
    const last = messages.length - 1;
    body.messages = messages.map((m, i) => (i === last && m.role === 'user' ? { ...m, content: `${m.content}\n\n/no_think` } : m));
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const url = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  // Tests inject a fetch; real calls go through post() so slow local models aren't cut off.
  const send = async (b: string) => {
    try {
      return f ? await f(url, { method: 'POST', headers, body: b }) : await post(url, headers, b);
    } catch (e) {
      throw new Error(`${cfg.baseUrl} request failed: ${describe(e)}`);
    }
  };
  let res = await send(JSON.stringify(body));
  if (res.status === 400 && !schema) {
    // Never for the schema request: a rejected schema is an error, not a silent unconstrained retry.
    // Some servers reject response_format; the prompt already asks for JSON only.
    delete body.response_format;
    count.n = 2;
    res = await send(JSON.stringify(body));
  }
  if (res.status === 429) throw new RateLimited(`rate limited by ${cfg.baseUrl}`);
  if (!res.ok) throw new Error(`${cfg.baseUrl} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  if (/^\s*data:/m.test(text)) return fromStream(text, cfg.baseUrl);
  // A 200 that isn't a chat completion (e.g. a retired endpoint answering "OK") is a failure, not an empty answer.
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${cfg.baseUrl} did not return a chat completion (got ${JSON.stringify(text.slice(0, 60))})`); }
  const d = parsed as { choices?: { message?: { content?: string; reasoning_content?: string; reasoning?: string } }[]; usage?: unknown; provider?: string; model?: string };
  const m = d.choices?.[0]?.message;
  if (!m?.content) throw new Error(`${cfg.baseUrl} returned no message content`);
  return { content: m.content, reasoning: m.reasoning_content ?? m.reasoning, usage: d.usage, ...(typeof d.provider === 'string' ? { provider: d.provider } : {}), ...(typeof d.model === 'string' ? { served_model: d.model } : {}) };
}

/** Assemble a server-sent-events chat stream into one result. */
function fromStream(text: string, baseUrl: string): Omit<ChatResult, 'attempts'> {
  let content = '';
  let reasoning = '';
  let usage: unknown;
  let finish: string | undefined;
  let provider: string | undefined;
  let served: string | undefined;
  for (const line of text.split('\n')) {
    const m = line.match(/^data:\s*(.*)$/);
    if (!m || m[1] === '[DONE]') continue;
    let ev: { choices?: { delta?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string | null }[]; usage?: unknown; provider?: string; model?: string; error?: { message?: string } };
    try { ev = JSON.parse(m[1]!); } catch { continue; }
    if (ev.error) throw new Error(`${baseUrl} stream error: ${ev.error.message ?? 'unknown'}`);
    const ch = ev.choices?.[0];
    content += ch?.delta?.content ?? '';
    reasoning += ch?.delta?.reasoning_content ?? ch?.delta?.reasoning ?? '';
    if (ch?.finish_reason) finish = ch.finish_reason;
    if (ev.usage) usage = ev.usage;
    if (typeof ev.provider === 'string') provider = ev.provider;
    if (typeof ev.model === 'string') served = ev.model;
  }
  if (!content) throw new Error(`${baseUrl} streamed no message content${finish ? ` (finish: ${finish})` : ''}`);
  // An answer cut off at max_tokens is incomplete JSON at best; report it as such rather than half-parsing it.
  if (finish === 'length') throw new Error(`${baseUrl} hit max_tokens before finishing`);
  return { content, reasoning: reasoning || undefined, usage, ...(provider ? { provider } : {}), ...(served ? { served_model: served } : {}) };
}

/** Pull the JSON object out of a reply, tolerating a ```json fence. */
export function parseJson(text: string): unknown {
  const slice = (s: string) => {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('no JSON object in reply');
    return JSON.parse(s.slice(start, end + 1));
  };
  // The whole reply first: a valid reply can hold a ``` fence inside a string (a rationale quoting code).
  try { return slice(text.trim()); } catch { /* fall back to the fenced block */ }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return slice((fenced ? fenced[1]! : text).trim());
}
