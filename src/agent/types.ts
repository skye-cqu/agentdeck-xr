/**
 * AgentDeck XR — agent core types.
 *
 * The agent runs an event-driven loop: an intent (text or, later, speech)
 * enters the queue, gets planned (LLM or deterministic mock), planned steps
 * are executed as tool calls, and every transition is recorded as a trace
 * step that the spatial console renders.
 */

/** Phases of the decision loop, rendered on the console status line. */
export type Phase = 'idle' | 'intake' | 'plan' | 'act' | 'trace';

/** Visible crew roles. Each intent is delegated across the crew. */
export type AgentRole = 'planner' | 'runner' | 'fixer';

export const ROLE_LABEL: Record<AgentRole, string> = {
  planner: 'Planner',
  runner: 'Runner',
  fixer: 'Fixer',
};

/** What one crew member is doing right now (drives avatar + panel row). */
export interface AgentActivity {
  role: AgentRole;
  phase: Phase | 'idle';
  summary: string;
}

/** One incoming user request. Voice input lands here as text (stub for now). */
export interface Intent {
  id: number;
  text: string;
  /** 'voice' reserved for the WebXR speech path; everything is 'text' today. */
  source: 'text' | 'voice';
}

/** A tool call the planner produced. */
export interface ToolCall {
  tool: string;
  args: Record<string, string | number>;
}

/** Planner output: one-line rationale plus concrete steps. */
export interface Plan {
  reasoning: string;
  steps: ToolCall[];
}

/** Result of executing one step. */
export interface ActionResult {
  ok: boolean;
  summary: string;
}

/** Ring-buffer trace entry — one per loop transition. */
export interface TraceStep {
  time: number;
  phase: Phase;
  summary: string;
}

/** Renderable task card state (drives the 3D card colors). */
export interface TaskCardState {
  id: number;
  title: string;
  priority: 'low' | 'normal' | 'high';
  state: 'queued' | 'acting' | 'done';
}

export const PHASE_LABEL: Record<Phase, string> = {
  idle: 'IDLE - waiting for intent',
  intake: 'INTAKE - parsing intent',
  plan: 'PLAN - reasoning',
  act: 'ACT - executing tools',
  trace: 'TRACE - recording results',
};
