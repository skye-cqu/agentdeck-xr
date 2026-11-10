/**
 * AgentRuntime — the event-driven intent -> plan -> act -> trace loop,
 * delegated across a visible three-role crew:
 *
 *   Planner  turns the intent into a plan (LLM or deterministic fallback)
 *   Runner   executes the plan's tool calls that manipulate the scene
 *   Fixer    verifies the result and closes the intent with a report
 *
 * Framework-agnostic: no IWSDK imports here. The spatial console subscribes
 * to runtime events and mirrors each role's activity into 3D (avatars, card
 * columns, trace rows). Voice input lands on the same dispatch() path as text
 * (source: 'voice') — the interface is ready for WebXR speech recognition
 * without loop changes.
 */

import { createLlmProvider, loadLlmConfig, localPlan, MockProvider } from './llm.js';
import type { LlmProvider, PlanContext } from './llm.js';
import { createToolRegistry } from './tools.js';
import type { SceneCommand } from './tools.js';
import type { AgentActivity, AgentRole, Intent, Phase, Plan, TaskCardState, TraceStep } from './types.js';
import { PHASE_LABEL, ROLE_LABEL } from './types.js';

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
  crew: Record<AgentRole, AgentActivity>;
}

interface RuntimeEvents {
  snapshot: RuntimeSnapshot;
  trace: TraceStep[];
  command: SceneCommand;
  card: TaskCardState;
  agent: AgentActivity;
  /** A card was claimed (grabbed) by the player: title + owning role. */
  claim: { title: string; owner: AgentRole };
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

  private crew: Record<AgentRole, AgentActivity> = {
    planner: { role: 'planner', phase: 'idle', summary: 'waiting for intent' },
    runner: { role: 'runner', phase: 'idle', summary: 'standing by' },
    fixer: { role: 'fixer', phase: 'idle', summary: 'standing by' },
  };

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
    agent: new Set(),
    claim: new Set(),
  };

  constructor(provider: LlmProvider = new MockProvider()) {
    this.provider = provider;
    this.tools = createToolRegistry(() => ({ open: this.cards.length, done: this.doneCount }));
    this.lastPlanReasoning = `Provider: ${provider.name} (${provider.model}).`;
    this.pushTrace('idle', `Crew online - provider ${provider.name}/${provider.model}.`);
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

  /** Player grabbed (claimed) a card in the scene. */
  claimCard(title: string, owner: AgentRole): void {
    this.emit('claim', { title, owner });
    const index = this.cards.findIndex((card) => card.title === title && card.state === 'queued');
    if (index >= 0) {
      this.cards.splice(index, 1);
      this.doneCount += 1;
    }
    this.setAgent('fixer', 'trace', `verifying player claim: "${title.slice(0, 32)}"`);
    this.pushTrace('trace', `[${ROLE_LABEL[owner]}] card claimed by player: "${title}".`);
    this.emit('snapshot', this.getSnapshot());
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
      crew: {
        planner: { ...this.crew.planner },
        runner: { ...this.crew.runner },
        fixer: { ...this.crew.fixer },
      },
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

  private setAgent(role: AgentRole, phase: Phase | 'idle', summary: string): void {
    this.crew[role] = { role, phase, summary };
    this.emit('agent', { ...this.crew[role] });
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
          // 'command' drives the spatial system (card mesh spawn); 'card'
          // carries the runtime state for data clients (UI counters, tests).
          this.emit('command', command);
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
      this.setAgent('planner', 'idle', 'waiting for intent');
      this.setAgent('runner', 'idle', 'standing by');
      this.setAgent('fixer', 'idle', 'standing by');
    }
  }

  private async runOne(intent: Intent): Promise<void> {
    this.lastIntent = intent.text;
    this.setPhase('intake');
    this.setAgent('planner', 'intake', `parsing intent #${intent.id}`);
    this.pushTrace(
      'intake',
      `#${intent.id} ${intent.source === 'voice' ? '[voice]' : '[text]'} "${intent.text}"`,
    );

    // -- plan (Planner; never blocks: degrade to deterministic mock on failure)
    this.setPhase('plan');
    this.setAgent('planner', 'plan', 'reasoning over intent');
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
        `[Planner] ${outcome.provider}/${outcome.model} in ${outcome.latencyMs}ms: ${plan.reasoning}`,
      );
    } else {
      plan = localPlan(intent.text, context);
      this.lastPlanReasoning = `${plan.reasoning} [degraded: ${outcome.error ?? 'unknown'}]`;
      this.pushTrace(
        'plan',
        `[Planner] ${outcome.provider ?? 'mock'} failed (${outcome.error ?? 'unknown'}) - degraded to deterministic mock.`,
      );
    }
    if (outcome.ok && outcome.data) {
      this.lastPlanReasoning = `[Planner] ${plan.reasoning} [${outcome.provider}/${outcome.model}]`;
    }

    // -- act (Runner executes scene tools; per-step role attribution) --
    this.setPhase('act');
    const summaries: string[] = [];
    for (const step of plan.steps) {
      const owner: AgentRole = step.tool === 'report_status' ? 'fixer' : 'runner';
      this.setAgent(owner, 'act', `running ${step.tool}`);
      const { commands, result } = this.tools.run(step);
      this.applyCommands(commands);
      summaries.push(result.summary);
      this.pushTrace('act', `[${ROLE_LABEL[owner]}] ${step.tool} -> ${result.summary}`);
    }
    this.lastActionResult = summaries.join(' ');

    // -- close (Fixer verifies the outcome and reports) --
    this.setPhase('trace');
    this.setAgent('fixer', 'trace', 'verifying results');
    this.pushTrace(
      'trace',
      `[Fixer] Intent #${intent.id} closed. ${this.cards.length} card(s) verified on the rail.`,
    );
  }
}
