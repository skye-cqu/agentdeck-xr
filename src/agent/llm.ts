/**
 * LLM decision layer for AgentDeck XR.
 *
 * Pattern borrowed from the T-012 project: a pluggable provider interface with
 * a deterministic offline fallback, so the agent loop NEVER blocks on network.
 *
 * Providers:
 *   - MockProvider  (default in dev / no key): deterministic keyword planner.
 *     Also the degradation target for every failure mode below.
 *   - OpenAICompatProvider: any OpenAI-compatible /chat/completions endpoint
 *     (OpenAI, Nebius, Groq, DeepSeek, local vLLM/ollama, ...) configured via
 *     Vite env vars. Keys stay client-side by design for the demo; a proxy
 *     worker is the production path (see README).
 *
 * Failure policy: bounded timeout, every failure (no key, timeout, HTTP,
 * unparseable JSON) degrades to the deterministic mock plan and is surfaced
 * in the trace, never thrown.
 */

import type { Plan, ToolCall } from './types.js';

export interface LlmResult<T> {
  ok: boolean;
  data?: T;
  provider: string;
  model: string;
  /** Set when !ok: 'no-key' | 'timeout' | 'http 500' | 'parse' | ... */
  error?: string;
  latencyMs: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** Plan one intent into reasoning + ordered tool calls. */
  planIntent(intentText: string, context: PlanContext): Promise<LlmResult<Plan>>;
}

export interface PlanContext {
  openTasks: number;
  doneTasks: number;
  knownTools: string[];
}

// ---------------------------------------------------------------------------
// Configuration (Vite env vars: prefix VITE_ so they reach the client)
// ---------------------------------------------------------------------------

export const DEFAULT_LLM_TIMEOUT_MS = 8_000;

export interface LlmConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
}

export function loadLlmConfig(env: Record<string, string | undefined> = import.meta.env): LlmConfig {
  return {
    baseUrl: env.VITE_LLM_BASE_URL?.trim() || 'https://api.openai.com/v1',
    apiKey: env.VITE_LLM_API_KEY?.trim() || undefined,
    model: env.VITE_LLM_MODEL?.trim() || 'gpt-4o-mini',
    timeoutMs:
      Number(env.VITE_LLM_TIMEOUT_MS) > 0 ? Number(env.VITE_LLM_TIMEOUT_MS) : DEFAULT_LLM_TIMEOUT_MS,
  };
}

/** Pick the provider: OpenAI-compatible when a key exists, Mock otherwise. */
export function createLlmProvider(config: LlmConfig): LlmProvider {
  if (config.apiKey) return new OpenAICompatProvider(config);
  return new MockProvider();
}

// ---------------------------------------------------------------------------
// MockProvider — deterministic offline planner (also the degradation target)
// ---------------------------------------------------------------------------

const TOOL_WORDS: Array<{ words: string[]; tool: string; args: Record<string, string> }> = [
  { words: ['plan', 'day', 'schedule', 'organize', 'organise'], tool: 'plan_day', args: {} },
  { words: ['clear', 'reset', 'remove', 'wipe'], tool: 'clear_tasks', args: {} },
  {
    words: ['add', 'spawn', 'create', 'new'],
    tool: 'spawn_task',
    args: { title: 'New task', priority: 'normal' },
  },
  { words: ['status', 'report', 'how many', 'summary'], tool: 'report_status', args: {} },
];

/** Deterministic fallback plan used by MockProvider and every failure path. */
export function localPlan(intentText: string, context: PlanContext): Plan {
  const lower = intentText.toLowerCase();
  const steps: ToolCall[] = [];

  const match = TOOL_WORDS.find((m) => m.words.some((w) => lower.includes(w)));
  if (match) {
    const args = { ...match.args };
    if (match.tool === 'spawn_task') {
      // Use the words after the trigger verb as the card title when present.
      const rest = intentText.split(/\s+/).slice(2).join(' ').trim();
      if (rest.length > 0) args.title = rest.slice(0, 48);
      if (lower.includes('urgent') || lower.includes('high')) args.priority = 'high';
    }
    steps.push({ tool: match.tool, args });
    if (match.tool === 'plan_day') {
      steps.push({ tool: 'spawn_task', args: { title: 'Review inbox', priority: 'normal' } });
      steps.push({ tool: 'spawn_task', args: { title: 'Deep work block', priority: 'high' } });
    }
  } else {
    steps.push({ tool: 'report_status', args: {} });
  }

  return {
    reasoning:
      `Mock planner matched intent "${intentText.slice(0, 60)}" against the keyword table ` +
      `(${context.openTasks} open, ${context.doneTasks} done). Add VITE_LLM_API_KEY for real reasoning.`,
    steps,
  };
}

export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'mock/deterministic';

  async planIntent(intentText: string, context: PlanContext): Promise<LlmResult<Plan>> {
    return {
      ok: true,
      data: localPlan(intentText, context),
      provider: this.name,
      model: this.model,
      latencyMs: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// OpenAICompatProvider — JSON-mode chat completions, degrade-to-mock on failure
// ---------------------------------------------------------------------------

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class OpenAICompatProvider implements LlmProvider {
  readonly name = 'openai-compat';
  readonly model: string;

  constructor(private readonly config: LlmConfig) {
    this.model = config.model;
  }

  async planIntent(intentText: string, context: PlanContext): Promise<LlmResult<Plan>> {
    const started = Date.now();
    const done = (r: Omit<LlmResult<Plan>, 'provider' | 'model' | 'latencyMs'>): LlmResult<Plan> => ({
      provider: this.name,
      model: this.model,
      latencyMs: Date.now() - started,
      ...r,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0.2,
          max_tokens: 400,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'You are the planner of a spatial agent in a VR workbench. Turn the user ' +
                'intent into 1-3 tool calls from this list only: ' +
                `${JSON.stringify(context.knownTools)}. ` +
                'Respond with ONLY a JSON object: ' +
                '{"reasoning": "one short sentence", "steps": [{"tool": "...", "args": {...}}]}',
            },
            {
              role: 'user',
              content: JSON.stringify({ intent: intentText, openTasks: context.openTasks }),
            },
          ],
        }),
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      return done({ ok: false, error: aborted ? 'timeout' : `network: ${String(err)}` });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) return done({ ok: false, error: `http ${res.status}` });
    let payload: ChatCompletionResponse;
    try {
      payload = (await res.json()) as ChatCompletionResponse;
    } catch {
      return done({ ok: false, error: 'parse' });
    }
    const content = payload.choices?.[0]?.message?.content ?? '';
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return done({ ok: false, error: 'parse' });
    }
    const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
    const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];
    const steps: ToolCall[] = [];
    for (const step of rawSteps) {
      if (step && typeof step === 'object' && typeof (step as ToolCall).tool === 'string') {
        const call = step as ToolCall;
        steps.push({
          tool: call.tool,
          args: (call.args && typeof call.args === 'object' ? call.args : {}) as Record<
            string,
            string | number
          >,
        });
      }
    }
    if (!reasoning.trim() || steps.length === 0) return done({ ok: false, error: 'parse' });
    return done({ ok: true, data: { reasoning: reasoning.trim(), steps } });
  }
}
