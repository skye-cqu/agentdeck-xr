/**
 * AgentConsoleSystem — bridges the AgentRuntime (src/agent) into the world.
 *
 * Responsibilities:
 *   - wire console panel buttons to runtime.dispatch() (text intents today;
 *     speech lands on the same path via dispatchVoiceIntent)
 *   - mirror runtime state into the panel (phase, intent, plan, trace ring)
 *   - apply tool SceneCommands: spawn/tint/clear task cards on the left rail
 *
 * The runtime is also exposed on window.agentdeck for headless testing and
 * for the future voice client (WebXR SpeechRecognition) to call dispatch().
 */

import {
  createSystem,
  Mesh,
  MeshStandardMaterial,
  UIKitMLAsset,
  Vector3,
} from '@iwsdk/core';
import { AgentRuntime, type RuntimeSnapshot } from './agent/loop.js';
import type { SceneCommand } from './agent/tools.js';
import type { TaskCardState, TraceStep } from './agent/types.js';
import { createTaskCard, tintTaskCard, type TaskCardVisualState } from './scene-assets/task-card.scene-asset.js';

const PRESET_INTENTS = {
  planDay: 'Plan my day: add the two most important focus tasks.',
  addCard: 'Add task card: review grant budget, urgent.',
  status: 'Give me a status report.',
  clear: 'Clear all task cards.',
} as const;

/** Rail on the left of the stage: cards stack bottom-up, tilted to the player. */
const RAIL_POSITION = new Vector3(-1.35, 1.25, -2.6);
const RAIL_SPACING = 0.26;
const RAIL_MAX_CARDS = 5;

interface PlacedCard {
  state: TaskCardState;
  mesh: Mesh;
  material: MeshStandardMaterial;
}

export class AgentConsoleSystem extends createSystem({}) {
  private runtime!: AgentRuntime;
  private placedCards: PlacedCard[] = [];
  private cardRail!: Mesh;

  init(): void {
    this.runtime = AgentRuntime.fromEnv();

    // -- console panel wiring ------------------------------------------------
    const panel = this.world.getSceneObject<UIKitMLAsset>('agent-console');
    const setText = (id: string, text: string, display?: string): void => {
      const el = panel?.getElementById(id);
      if (el == null) return;
      el.setProperties({ text, ...(display ? { display } : {}) });
    };

    const wireButton = (id: string, handler: () => void): void => {
      const el = panel?.getElementById(id);
      if (el == null) return;
      el.addEventListener('click', handler);
      this.cleanupFuncs.push(() => el.removeEventListener('click', handler));
    };

    wireButton('btn-plan-day', () => this.runtime.dispatch(PRESET_INTENTS.planDay));
    wireButton('btn-add-card', () => this.runtime.dispatch(PRESET_INTENTS.addCard));
    wireButton('btn-status', () => this.runtime.dispatch(PRESET_INTENTS.status));
    wireButton('btn-clear', () => this.runtime.dispatch(PRESET_INTENTS.clear));

    setText('plan-text', `Provider: ${this.runtime.getSnapshot().provider}/${this.runtime.getSnapshot().model}`);

    this.runtime.on('snapshot', (snapshot) => this.renderSnapshot(setText, snapshot));
    this.runtime.on('trace', (trace) => this.renderTrace(trace, setText));
    this.runtime.on('command', (command) => this.applyCommand(command));

    // -- task card rail ------------------------------------------------------
    this.cardRail = new Mesh();
    this.cardRail.name = 'AgentDeckCardRail';
    this.world.scene.add(this.cardRail);

    // -- headless/2D test hooks: window.agentdeck ----------------------------
    const globalScope = window as typeof window & { agentdeck?: Record<string, unknown> };
    globalScope.agentdeck = {
      dispatch: (text: string) => this.runtime.dispatch(text, 'text'),
      /** Reserved for the WebXR speech client; voice follows the text path. */
      dispatchVoice: (text: string) => this.runtime.dispatch(text, 'voice'),
      snapshot: () => this.runtime.getSnapshot(),
      trace: () => this.runtime.getTrace(),
    };

    this.renderTrace(this.runtime.getTrace(), setText);
  }

  dispose(): void {
    this.world.scene.remove(this.cardRail);
    this.placedCards = [];
  }

  // -- rendering -------------------------------------------------------------

  private renderSnapshot(setText: (id: string, text: string) => void, snapshot: RuntimeSnapshot): void {
    setText('phase-text', snapshot.phaseLabel);
    setText('intent-text', snapshot.lastIntent || '-');
    setText('plan-text', snapshot.lastPlanReasoning);
    setText('result-text', snapshot.lastActionResult || '-');
    setText('cards-text', `TASK CARDS: ${snapshot.openTasks} open / ${snapshot.doneTasks} done`);
  }

  private renderTrace(trace: TraceStep[], setText: (id: string, text: string) => void): void {
    // trace[0] is oldest; render oldest at the top, newest at the bottom row.
    const rows = [...trace].slice(-6);
    for (let i = 0; i < 6; i++) {
      const step = rows[rows.length - 1 - i]; // newest on the last row
      const rowId = `trace-${5 - i}`;
      setText(rowId, step ? `[${step.phase}] ${step.summary}` : '-');
    }
  }

  private applyCommand(command: SceneCommand): void {
    if (command.kind === 'spawn-card') {
      this.spawnCard(command.title, command.priority);
    } else if (command.kind === 'clear-cards') {
      for (const card of this.placedCards) {
        this.cardRail.remove(card.mesh);
      }
      this.placedCards = [];
    } else if (command.kind === 'pulse-act') {
      // Flash active cards blue while the agent is acting.
      for (const card of this.placedCards) {
        if (card.state.state === 'queued') {
          card.material.emissive.set('#3B82F6');
          card.material.emissiveIntensity = 1.4;
        }
      }
    }
    this.syncCardStates();
  }

  private spawnCard(title: string, priority: TaskCardState['priority']): void {
    const mesh = createTaskCard();
    const material = (mesh.material as MeshStandardMaterial).clone();
    mesh.material = material;
    const index = Math.min(this.placedCards.length, RAIL_MAX_CARDS - 1);
    mesh.position.set(
      RAIL_POSITION.x,
      RAIL_POSITION.y + index * RAIL_SPACING,
      RAIL_POSITION.z - index * 0.02,
    );
    mesh.rotation.y = 0.35; // slight angle toward the player
    this.cardRail.add(mesh);
    const card: PlacedCard = {
      state: { id: Date.now() + index, title, priority, state: 'queued' },
      mesh,
      material,
    };
    this.placedCards.push(card);
    if (this.placedCards.length > RAIL_MAX_CARDS) {
      const removed = this.placedCards.shift();
      if (removed) this.cardRail.remove(removed.mesh);
    }
    tintTaskCard(mesh, card.state.state);
  }

  /** Reflect task state onto card materials (queued amber / acting blue / done green). */
  private syncCardStates(): void {
    this.placedCards.forEach((card, index) => {
      const visual = card.state.state as TaskCardVisualState;
      card.material.color.set(
        visual === 'done' ? '#14532D' : visual === 'acting' ? '#2563EB' : '#6B7280',
      );
      card.material.emissive.set(
        visual === 'done' ? '#22C55E' : visual === 'acting' ? '#3B82F6' : '#F5D90A',
      );
      card.material.emissiveIntensity = visual === 'acting' ? 1.4 : 0.55;
      card.mesh.position.y = RAIL_POSITION.y + index * RAIL_SPACING;
    });
  }
}
