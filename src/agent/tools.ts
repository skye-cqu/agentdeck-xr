/**
 * Tool registry for the agent loop.
 *
 * Tools are scene-agnostic: they return SceneCommand objects that the
 * AgentConsoleSystem applies to the world. This keeps the agent core unit
 * testable and lets future voice/2D clients reuse the same loop unchanged.
 */

import type { ActionResult, TaskCardState, ToolCall } from './types.js';

export type SceneCommand =
  | { kind: 'spawn-card'; title: string; priority: TaskCardState['priority'] }
  | { kind: 'clear-cards' }
  | { kind: 'pulse-act' };

export type ToolExecutor = (args: Record<string, string | number>) => {
  commands: SceneCommand[];
  result: ActionResult;
};

const asString = (v: string | number | undefined, fallback: string): string =>
  typeof v === 'string' && v.trim() ? v.trim() : fallback;

const asPriority = (v: string | number | undefined): TaskCardState['priority'] =>
  v === 'high' || v === 'low' ? v : 'normal';

export const TOOL_NAMES = ['plan_day', 'spawn_task', 'clear_tasks', 'report_status'] as const;

export function createToolRegistry(stats: () => { open: number; done: number }): {
  run: (call: ToolCall) => { commands: SceneCommand[]; result: ActionResult };
} {
  const registry: Record<string, ToolExecutor> = {
    plan_day: () => ({
      commands: [{ kind: 'pulse-act' }],
      result: {
        ok: true,
        summary:
          'Daily plan drafted: 1) review inbox, 2) deep work block, 3) wrap-up review. ' +
          'Two focus tasks pinned as cards.',
      },
    }),
    spawn_task: (args) => ({
      commands: [
        { kind: 'spawn-card', title: asString(args.title, 'New task'), priority: asPriority(args.priority) },
      ],
      result: { ok: true, summary: `Task card spawned: "${asString(args.title, 'New task')}".` },
    }),
    clear_tasks: () => ({
      commands: [{ kind: 'clear-cards' }],
      result: { ok: true, summary: 'All task cards cleared.' },
    }),
    report_status: () => {
      const s = stats();
      return {
        commands: [{ kind: 'pulse-act' }],
        result: { ok: true, summary: `Status: ${s.open} open card(s), ${s.done} completed.` },
      };
    },
  };

  return {
    run(call: ToolCall) {
      const executor = registry[call.tool];
      if (!executor) {
        return {
          commands: [],
          result: { ok: false, summary: `Unknown tool "${call.tool}" — step skipped.` },
        };
      }
      return executor(call.args);
    },
  };
}
