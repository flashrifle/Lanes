// Edges passing through a row (up < row < down).
//
// Inspired by EdgesInRowGenerator from JetBrains intellij-community `platform/vcs-log/graph`
// (com.intellij.vcs.log.graph.impl.print).
// Copyright 2000-2024 JetBrains s.r.o. and contributors.
// Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// Modifications: instead of walking a bounded window (which is approximate for very long edges),
// one exact O(rows + edges) sweep stores the pass-through set at every BLOCK-th row; a row is then
// computed from the nearest block start by walking forward.

import type { VisibleGraph } from './visibleGraph';

const BLOCK = 64;

export class EdgesInRow {
  private readonly blocks: Int32Array[] = [];
  private readonly g: VisibleGraph;

  constructor(g: VisibleGraph) {
    this.g = g;
    const { rows, eDown, downStart, downEdges, upStart, upEdges } = g;
    const active = new Set<number>();
    for (let r = 0; r < rows; r++) {
      for (let k = upStart[r]; k < upStart[r + 1]; k++) active.delete(upEdges[k]);
      if (r % BLOCK === 0) this.blocks.push(Int32Array.from(active));
      for (let k = downStart[r]; k < downStart[r + 1]; k++) {
        const e = downEdges[k];
        if (eDown[e] > r + 1) active.add(e);
      }
    }
  }

  /** normal edges e with eUp[e] < row < eDown[e] */
  get(row: number, out: number[]): void {
    const { eDown, downStart, downEdges } = this.g;
    const b = (row / BLOCK) | 0;
    const snap = this.blocks[b];
    for (let i = 0; i < snap.length; i++) {
      const e = snap[i];
      if (eDown[e] > row) out.push(e);
    }
    for (let r = b * BLOCK; r < row; r++) {
      for (let k = downStart[r]; k < downStart[r + 1]; k++) {
        const e = downEdges[k];
        if (eDown[e] > row) out.push(e);
      }
    }
  }
}
