/**
 * Task card prefab for the AgentDeck workbench: a rounded slab that floats on
 * the left rail. The prototype material is shared; AgentConsoleSystem clones
 * it per spawned card to tint by state (queued / acting / done).
 */

import {
  createSceneMaterial,
  createScenePrimitiveObject,
  Mesh,
  MeshStandardMaterial,
} from '@iwsdk/core';

const cardMaterial = createSceneMaterial({
  id: 'agentdeck-card',
  model: 'standard',
  baseColor: '#5B6472',
  roughness: 0.55,
});

export const CARD_STATE_TINT: Record<TaskCardVisualState, { color: string; emissive: string }> = {
  queued: { color: '#6B7280', emissive: '#F5D90A' },
  acting: { color: '#2563EB', emissive: '#3B82F6' },
  done: { color: '#14532D', emissive: '#22C55E' },
};

export type TaskCardVisualState = 'queued' | 'acting' | 'done';

export function createTaskCard(): Mesh {
  return createScenePrimitiveObject(
    {
      geometry: {
        type: 'roundedBox',
        size: [0.3, 0.18, 0.016],
        radius: 0.02,
        segments: 4,
      },
    },
    cardMaterial,
  );
}

/** Restyle one placed card instance without touching the shared prototype. */
export function tintTaskCard(mesh: Mesh, state: TaskCardVisualState): MeshStandardMaterial[] {
  const tint = CARD_STATE_TINT[state];
  const tinted: MeshStandardMaterial[] = [];
  mesh.traverse((child) => {
    const meshChild = child as Mesh;
    if (!('material' in meshChild) || meshChild.material == null) return;
    const source = Array.isArray(meshChild.material) ? meshChild.material : [meshChild.material];
    const clones = source.map((material) => {
      const clone = (material as MeshStandardMaterial).clone();
      clone.color.set(tint.color);
      clone.emissive.set(tint.emissive);
      clone.emissiveIntensity = state === 'acting' ? 1.4 : 0.55;
      clone.needsUpdate = true;
      return clone;
    });
    meshChild.material = Array.isArray(meshChild.material) ? clones : clones[0];
    tinted.push(...(clones as MeshStandardMaterial[]));
  });
  return tinted;
}
