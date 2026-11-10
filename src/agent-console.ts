/**
 * AgentConsoleSystem — bridges the AgentRuntime (src/agent) into the world.
 *
 * Responsibilities:
 *   - wire console panel buttons to runtime.dispatch() (text intents today;
 *     speech lands on the same path via dispatchVoice)
 *   - mirror runtime state into the panel (phase, intent, plan, crew rows,
 *     trace ring)
 *   - render the visible crew: one emissive avatar per role bobbing above its
 *     card column while that role is working
 *   - apply tool SceneCommands: spawn task cards into the owning role's
 *     column, tint by state, clear on command
 *   - grabbing a card = the player claims the task: the card turns green,
 *     Fixer "verifies" it and the claim enters the trace
 *
 * The runtime is also exposed on window.agentdeck for headless testing and
 * for the future voice client (WebXR SpeechRecognition) to call dispatch().
 */

import {
  createSystem,
  DistanceGrabbable,
  Grabbed,
  Mesh,
  MeshStandardMaterial,
  RayInteractable,
  SphereGeometry,
  UIKitMLAsset,
} from '@iwsdk/core';
import { CrewCard } from './components.js';
import { AgentRuntime, type RuntimeSnapshot } from './agent/loop.js';
import type { SceneCommand } from './agent/tools.js';
import type { AgentActivity, AgentRole, TaskCardState, TraceStep } from './agent/types.js';
import { ROLE_LABEL } from './agent/types.js';
import { createTaskCard, tintTaskCard } from './scene-assets/task-card.scene-asset.js';

const PRESET_INTENTS = {
  planDay: 'Plan my day: add the two most important focus tasks.',
  addCard: 'Add task card: review grant budget, urgent.',
  status: 'Give me a status report.',
  clear: 'Clear all task cards.',
} as const;

/** Crew rail on the left: one card column per role, avatars float above. */
const COLUMN_X: Record<AgentRole, number> = { planner: -2.05, runner: -1.5, fixer: -0.95 };
const RAIL_Z = -1.8;
const RAIL_BASE_Y = 1.3;
const AVATAR_Y = 1.92;
const RAIL_SPACING = 0.26;
const MAX_PER_COLUMN = 2;

const ROLE_COLOR: Record<AgentRole, { color: string; emissive: string }> = {
  planner: { color: '#1D4ED8', emissive: '#3B82F6' },
  runner: { color: '#B45309', emissive: '#F59E0B' },
  fixer: { color: '#15803D', emissive: '#22C55E' },
};

interface PlacedCard {
  state: TaskCardState;
  mesh: Mesh;
  material: MeshStandardMaterial;
  role: AgentRole;
  slot: number;
}

export class AgentConsoleSystem extends createSystem({
  /** Grabbing a card = the player claims that task (transient Grabbed tag). */
  grabbedCards: { required: [CrewCard, Grabbed] },
}) {
  private runtime!: AgentRuntime;
  private placedCards: PlacedCard[] = [];
  private cardRail!: Mesh;
  private crewRoot!: Mesh;
  private avatars = new Map<AgentRole, { mesh: Mesh; material: MeshStandardMaterial; working: boolean }>();

  init(): void {
    this.runtime = AgentRuntime.fromEnv();

    // -- console panel wiring ------------------------------------------------
    const panel = this.world.getSceneObject<UIKitMLAsset>('agent-console');
    const setText = (id: string, text: string): void => {
      const el = panel?.getElementById(id);
      if (el == null) return;
      el.setProperties({ text });
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

    const snapshot = this.runtime.getSnapshot();
    setText('plan-text', `Provider: ${snapshot.provider}/${snapshot.model}`);

    this.runtime.on('snapshot', (snap) => this.renderSnapshot(setText, snap));
    this.runtime.on('trace', (trace) => this.renderTrace(trace, setText));
    this.runtime.on('command', (command) => this.applyCommand(command));
    this.runtime.on('agent', (activity) => this.renderAgent(activity));
    this.runtime.on('claim', ({ owner }) => this.flashAvatar(owner, 'verifying player claim'));

    // -- card rail + crew avatars --------------------------------------------
    this.cardRail = new Mesh();
    this.cardRail.name = 'AgentDeckCardRail';
    this.world.scene.add(this.cardRail);

    this.crewRoot = new Mesh();
    this.crewRoot.name = 'AgentDeckCrew';
    this.world.scene.add(this.crewRoot);
    for (const role of ['planner', 'runner', 'fixer'] as AgentRole[]) {
      const mesh = new Mesh(new SphereGeometry(0.085, 24, 16));
      const material = new MeshStandardMaterial({
        color: ROLE_COLOR[role].color,
        emissive: ROLE_COLOR[role].emissive,
        emissiveIntensity: 0.5,
      });
      mesh.material = material;
      mesh.position.set(COLUMN_X[role], AVATAR_Y, RAIL_Z);
      mesh.name = `Agent-${ROLE_LABEL[role]}`;
      this.crewRoot.add(mesh);
      this.avatars.set(role, { mesh, material, working: false });
    }

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

    // Grabbing a card = the player claims that task: tint green, Fixer
    // "verifies" the claim, trace records the handoff.
    this.queries.grabbedCards.subscribe('qualify', (entity) => {
      const title = entity.getValue(CrewCard, 'title');
      const owner = entity.getValue(CrewCard, 'owner') as AgentRole;
      const already = entity.getValue(CrewCard, 'claimed');
      if (already || title == null || owner == null) return;
      entity.setValue(CrewCard, 'claimed', true);
      const placed = this.placedCards.find((card) => card.state.title === title);
      if (placed) {
        placed.state.state = 'done';
        tintTaskCard(placed.mesh, 'done');
      }
      this.runtime.claimCard(title, owner);
    });
  }

  update(_delta: number, time: number): void {
    for (const { mesh, material, working } of this.avatars.values()) {
      if (working) {
        mesh.position.y = AVATAR_Y + Math.sin(time * 3) * 0.03;
        material.emissiveIntensity = 1.6;
      } else {
        material.emissiveIntensity = 0.5;
      }
    }
  }

  dispose(): void {
    this.world.scene.remove(this.cardRail);
    this.world.scene.remove(this.crewRoot);
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

  private renderAgent(activity: AgentActivity): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('agent-console');
    const el = panel?.getElementById(`crew-${activity.role}`);
    if (el != null) {
      el.setProperties({
        text: `${ROLE_LABEL[activity.role]}: ${activity.phase.toUpperCase()} - ${activity.summary}`,
      });
    }
    const avatar = this.avatars.get(activity.role);
    if (avatar) avatar.working = activity.phase !== 'idle';
  }

  private flashAvatar(role: AgentRole, summary: string): void {
    this.renderAgent({ role, phase: 'trace', summary });
  }

  private renderTrace(trace: TraceStep[], setText: (id: string, text: string) => void): void {
    // Newest entries at the bottom of the ring (last row = latest).
    const rows = [...trace].slice(-4);
    for (let i = 0; i < 4; i++) {
      const step = rows[rows.length - 1 - i];
      const rowId = `trace-${3 - i}`;
      setText(rowId, step ? `[${step.phase}] ${step.summary}` : '-');
    }
  }

  private applyCommand(command: SceneCommand): void {
    if (command.kind === 'spawn-card') {
      this.spawnCard(command.title, command.priority, command.owner);
    } else if (command.kind === 'clear-cards') {
      for (const card of this.placedCards) {
        this.cardRail.remove(card.mesh);
      }
      this.placedCards = [];
    } else if (command.kind === 'pulse-act') {
      for (const card of this.placedCards) {
        if (card.state.state === 'queued') {
          card.material.emissive.set('#3B82F6');
          card.material.emissiveIntensity = 1.4;
        }
      }
    }
  }

  private spawnCard(title: string, priority: TaskCardState['priority'], role: AgentRole): void {
    const column = this.placedCards.filter((card) => card.role === role && card.state.state !== 'done');
    const slot = Math.min(column.length, MAX_PER_COLUMN - 1);
    const mesh = createTaskCard();
    const material = (mesh.material as MeshStandardMaterial).clone();
    mesh.material = material;
    mesh.position.set(COLUMN_X[role], RAIL_BASE_Y + slot * RAIL_SPACING, RAIL_Z);
    mesh.rotation.y = 0.35; // slight angle toward the player
    this.cardRail.add(mesh);

    // Make the card interactable/grabbable and tag it for the crew system.
    const entity = this.world.createTransformEntity(mesh);
    entity.addComponent(CrewCard, { title, owner: role });
    entity.addComponent(RayInteractable);
    entity.addComponent(DistanceGrabbable, { movementMode: 'MoveFromTarget' });

    const card: PlacedCard = {
      state: { id: Date.now() + slot, title, priority, state: 'queued' },
      mesh,
      material,
      role,
      slot,
    };
    this.placedCards.push(card);
    if (this.placedCards.filter((c) => c.role === role).length > MAX_PER_COLUMN) {
      const overflow = this.placedCards.find((c) => c.role === role);
      if (overflow) {
        this.cardRail.remove(overflow.mesh);
        this.placedCards = this.placedCards.filter((c) => c !== overflow);
      }
    }
    tintTaskCard(mesh, card.state.state);
  }
}
