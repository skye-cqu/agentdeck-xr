/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createComponent, defineComponents, Types } from '@iwsdk/core';
import { Robot } from './robot-component.js';

/** Tags a spawned task-card mesh for the crew system (owner column + claim). */
export const CrewCard = createComponent('CrewCard', {
  title: { type: Types.String, default: '' },
  /** Planner | Runner | Fixer column owner. */
  owner: { type: Types.String, default: 'runner' },
  claimed: { type: Types.Boolean, default: false },
});

export default defineComponents([Robot, CrewCard]);
