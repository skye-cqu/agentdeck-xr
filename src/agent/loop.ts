/**
 * AgentRuntime — the event-driven intent -> plan -> act -> trace loop.
 *
 * Framework-agnostic: no IWSDK imports here. The spatial console subscribes
 * to runtime events and mirrors the state machine into 3D. Voice input lands
 * on the same dispatch() path as text (source: 'voice') — the interface is
 * ready for WebXR speech recognition without loop changes.
 */

import { createLlmProvider, loadLlmConfig, localPlan, MockProvider } from './llm.js';
import type { LlmProvider, PlanContext } from './llm.js';
import { createToolRegistry } from './tools.js';
import type { SceneCommand } from './tools.js';
import type { Intent, Phase, Plan, TaskCardState, TraceStep } from './types.js';
import { PHASE_LABEL } from './types.js';

const TRACE_CAPACITY = 6;

export interface RuntimeSnapshot {
  phase: Phase;
  phaseLabel: string;
  lastIntent: string;
  lastPlanReasoning: string;
  lastActionResult: string;
  provider: string;
  model: string;
  openTasks: number;
  doneTasks: number;
}

interface RuntimeEvents {
  snapshot: RuntimeSnapshot;
  trace: TraceStep[];
  command: SceneCommand;
  card: TaskCardState;
}

export class AgentRuntime {
  private phase: Phase = 'idle';
  private queue: Intent[] = [];
  private processing = false;
  private nextId = 1;
  private trace: TraceStep[] = [];
  private cards: TaskCardState[] = [];
  private doneCount = 0;
  private nextCardId = 1;

  private lastIntent = '';
  private lastPlanReasoning = 'No plan yet - dispatch an intent to see reasoning.';
  private lastActionResult = '';
  private readonly provider: LlmProvider;
  private readonly tools: ReturnType<typeof createToolRegistry>;

  private listeners: { [K in keyof RuntimeEvents]: Set<(payload: RuntimeEvents[K]) => void> } = {
    snapshot: new Set(),
    trace: new Set(),
    command: new Set(),
    card: new Set(),
  };

  constructor(provider: LlmProvider = new MockProvider()) {
    this.provider = provider;
    this.tools = createToolRegistry(() => ({ open: this.cards.length, done: this.doneCount }));
    this.lastPlanReasoning = `Provider: ${provider.name} (${provider.model}).`;
    this.pushTrace('idle', `Runtime online - provider ${provider.name}/${provider.model}.`);
  }

  /** Build a runtime from Vite env config (mock fallback without a key). */
  static fromEnv(): AgentRuntime {
    return new AgentRuntime(createLlmProvider(loadLlmConfig()));
  }

  on<K extends keyof RuntimeEvents>(event: K, handler: (payload: RuntimeEvents[K]) => void): () => void {
    this.listeners[event].add(handler);
    return () => this.listeners[event].delete(handler);
  }

  /** Single entry point for all input channels (buttons today, speech later). */
  dispatch(text: string, source: Intent['source'] = 'text'): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.queue.push({ id: this.nextId++, text: trimmed, source });
    void this.pump();
  }

  getSnapshot(): RuntimeSnapshot {
    return {
      phase: this.phase,
      phaseLabel: PHASE_LABEL[this.phase],
      lastIntent: this.lastIntent,
      lastPlanReasoning: this.lastPlanReasoning,
      lastActionResult: this.lastActionResult,
      provider: this.provider.name,
      model: this.provider.model,
      openTasks: this.cards.length,
      doneTasks: this.doneCount,
    };
  }

  getTrace(): TraceStep[] {
    return [...this.trace];
  }

  getCards(): TaskCardState[] {
    return [...this.cards];
  }

  // -- internals ------------------------------------------------------------

  private emit<K extends keyof RuntimeEvents>(event: K, payload: RuntimeEvents[K]): void {
    for (const handler of this.listeners[event]) handler(payload);
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.emit('snapshot', this.getSnapshot());
  }

  private pushTrace(phase: Phase, summary: string): void {
    this.trace.push({ time: Date.now(), phase, summary });
    if (this.trace.length > TRACE_CAPACITY) this.trace.shift();
    this.emit('trace', this.getTrace());
  }

  private applyCommands(commands: SceneCommand[]): void {
    for (const command of commands) {
      switch (command.kind) {
        case 'spawn-card': {
          const card: TaskCardState = {
            id: this.nextCardId++,
            title: command.title,
            priority: command.priority,
            state: 'queued',
          };
          this.cards.push(card);
          this.emit('card', card);
          break;
        }
        case 'clear-cards': {
          this.doneCount += this.cards.length;
          this.cards = [];
          this.emit('command', command);
          break;
        }
        case 'pulse-act': {
          this.emit('command', command);
          break;
        }
      }
    }
  }

  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const intent = this.queue.shift()!;
        await this.runOne(intent);
      }
    } finally {
      this.processing = false;
      this.setPhase('idle');
    }
  }

  private async runOne(intent: Intent): Promise<void> {
    this.lastIntent = intent.text;
    this.setPhase('intake');
    this.pushTrace(
      'intake',
      `#${intent.id} ${intent.source === 'voice' ? '[voice]' : '[text]'} "${intent.text}"`,
    );

    // -- plan (never blocks: degrade to deterministic mock on any failure) --
    this.setPhase('plan');
    const context: PlanContext = {
      openTasks: this.cards.length,
      doneTasks: this.doneCount,
      knownTools: ['plan_day', 'spawn_task', 'clear_tasks', 'report_status'],
    };
    let outcome: Awaited<ReturnType<LlmProvider['planIntent']>>;
    try {
      outcome = await this.provider.planIntent(intent.text, context);
    } catch (err) {
      outcome = {
        ok: false,
        error: `network: ${String(err)}`,
        provider: this.provider.name,
        model: this.provider.model,
        latencyMs: 0,
      };
    }
    let plan: Plan;
    if (outcome.ok && outcome.data) {
      plan = outcome.data;
      this.pushTrace(
        'plan',
        `${outcome.provider}/${outcome.model} in ${outcome.latencyMs}ms: ${plan.reasoning}`,
      );
    } else {
      plan = localPlan(intent.text, context);
      this.lastPlanReasoning = `${plan.reasoning} [degraded: ${outcome.error ?? 'unknown'}]`;
      this.pushTrace(
        'plan',
        `${outcome.provider ?? 'mock'} failed (${outcome.error ?? 'unknown'}) - degraded to deterministic mock.`,
      );
    }
    if (outcome.ok && outcome.data) {
      this.lastPlanReasoning = `${plan.reasoning} [${outcome.provider}/${outcome.model}]`;
    }

    // -- act --
    this.setPhase('act');
    const summaries: string[] = [];
    for (const step of plan.steps) {
      const { commands, result } = this.tools.run(step);
      this.applyCommands(commands);
      summaries.push(result.summary);
      this.pushTrace('act', `${step.tool} -> ${result.summary}`);
    }
    this.lastActionResult = summaries.join(' ');
    this.setPhase('trace');
    this.pushTrace('trace', `Intent #${intent.id} closed. ${this.cards.length} card(s) on the rail.`);
  }
}
