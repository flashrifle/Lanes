// Print elements per row.
//
// Port of PrintElementGeneratorImpl and GraphElementComparatorByLayoutIndex from JetBrains
// intellij-community `platform/vcs-log/graph` (com.intellij.vcs.log.graph.impl.print).
// Copyright 2000-2024 JetBrains s.r.o. and contributors.
// Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// Modifications: TypeScript port producing the Lanes GraphRow contract; elements are
// encoded as numbers (edge id >= 0, node = ~row); Map-based LRU caches; no "very long edge"
// mode (collapseLongEdges=false shows every edge in full, without arrows).

import type { GraphArrowElement, GraphEdgeElement, GraphRow } from '../types';
import type { LineColors } from './colors';
import { EdgesInRow } from './edgesInRow';
import type { VisibleGraph } from './visibleGraph';

export const LONG_EDGE_SIZE = 30;
const LONG_EDGE_PART_SIZE = 1;
const ELEMENTS_CACHE = 2048;
const ROW_CACHE = 2048;

class Lru<V> {
  private readonly map = new Map<number, V>();
  private readonly cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
  get(k: number): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: number, v: V): void {
    this.map.set(k, v);
    if (this.map.size > this.cap) this.map.delete(this.map.keys().next().value as number);
  }
}

const Arrow = { None: 0, Down: 1, Up: 2 } as const;
type Arrow = (typeof Arrow)[keyof typeof Arrow];

export class PrintElementGenerator {
  private readonly g: VisibleGraph;
  private readonly rowLayout: Int32Array;
  private readonly colors: LineColors;
  private readonly edgesInRow: EdgesInRow;
  private readonly longEdgeSize: number;
  private readonly visiblePartSize: number;
  private readonly elementsCache = new Lru<number[]>(ELEMENTS_CACHE);
  private readonly rowCache = new Lru<GraphRow>(ROW_CACHE);
  private readonly tmp: number[] = [];
  readonly maxLaneCount: number;

  constructor(g: VisibleGraph, rowLayout: Int32Array, colors: LineColors, collapseLongEdges: boolean) {
    this.g = g;
    this.rowLayout = rowLayout;
    this.colors = colors;
    this.edgesInRow = new EdgesInRow(g);
    this.longEdgeSize = collapseLongEdges ? LONG_EDGE_SIZE : Number.POSITIVE_INFINITY;
    this.visiblePartSize = LONG_EDGE_PART_SIZE;
    this.maxLaneCount = this.computeMaxLaneCount();
  }

  /** Exact max number of elements in any row (= max lane count) via a difference array. */
  private computeMaxLaneCount(): number {
    const { rows, edgeCount, eUp, eDown } = this.g;
    if (rows === 0) return 0;
    const diff = new Int32Array(rows + 1);
    const add = (from: number, to: number) => {
      // inclusive range
      if (from > to) return;
      diff[from]++;
      diff[to + 1]--;
    };
    const part = this.visiblePartSize;
    for (let e = 0; e < edgeCount; e++) {
      const u = eUp[e];
      const d = eDown[e];
      if (d < 0) {
        if (u + 1 < rows) add(u + 1, u + 1);
        continue;
      }
      if (d - u < 2) continue;
      if (d - u < this.longEdgeSize || 2 * part >= d - u - 1) add(u + 1, d - 1);
      else {
        add(u + 1, u + part);
        add(d - part, d - 1);
      }
    }
    let max = 0;
    let cur = 0;
    for (let r = 0; r < rows; r++) {
      cur += diff[r];
      if (cur + 1 > max) max = cur + 1;
    }
    return max;
  }

  private isEdgeVisibleInRow(e: number, row: number): boolean {
    const u = this.g.eUp[e];
    const d = this.g.eDown[e];
    return d - u < this.longEdgeSize || Math.min(row - u, d - row) <= this.visiblePartSize;
  }

  private arrowType(e: number, row: number): Arrow {
    const u = this.g.eUp[e];
    const d = this.g.eDown[e];
    if (d < 0) return u === row - 1 ? Arrow.Down : Arrow.None; // not-loaded parent
    if (d - u >= this.longEdgeSize) {
      if (row - u === this.visiblePartSize) return Arrow.Down;
      if (d - row === this.visiblePartSize) return Arrow.Up;
    }
    return Arrow.None;
  }

  // ---- GraphElementComparatorByLayoutIndex ----
  private compareEdgeNode(e: number, node: number): number {
    const li = this.rowLayout;
    const u = this.g.eUp[e];
    const d = this.g.eDown[e];
    if (d < 0) return li[u] - li[node];
    const m = Math.max(li[u], li[d]);
    const nl = li[node];
    if (m !== nl) return m - nl;
    return u - node;
  }

  private compareEdges(e1: number, e2: number): number {
    const { eUp, eDown } = this.g;
    if (eDown[e1] < 0) return -this.compareEdgeNode(e2, eUp[e1]);
    if (eDown[e2] < 0) return this.compareEdgeNode(e1, eUp[e2]);
    const u1 = eUp[e1];
    const u2 = eUp[e2];
    if (u1 === u2) {
      const d1 = eDown[e1];
      const d2 = eDown[e2];
      if (d1 < d2) return -this.compareEdgeNode(e2, d1);
      return this.compareEdgeNode(e1, d2);
    }
    if (u1 < u2) return this.compareEdgeNode(e1, u2);
    return -this.compareEdgeNode(e2, u1);
  }

  private readonly compare = (a: number, b: number): number => {
    if (a >= 0) return b >= 0 ? this.compareEdges(a, b) : this.compareEdgeNode(a, ~b);
    return b >= 0 ? -this.compareEdgeNode(b, ~a) : 0;
  };

  /** node + visible edges in row, sorted; position = index */
  sortedElements(row: number): number[] {
    const cached = this.elementsCache.get(row);
    if (cached) return cached;
    const { eDown, downStart, downEdges } = this.g;
    const tmp = this.tmp;
    tmp.length = 0;
    this.edgesInRow.get(row, tmp);
    const result: number[] = [~row];
    for (let i = 0; i < tmp.length; i++) if (this.isEdgeVisibleInRow(tmp[i], row)) result.push(tmp[i]);
    if (row > 0) {
      for (let k = downStart[row - 1]; k < downStart[row]; k++) {
        const e = downEdges[k];
        if (eDown[e] < 0) result.push(e);
      }
    }
    if (result.length > 1) result.sort(this.compare);
    this.elementsCache.set(row, result);
    return result;
  }

  /** Same value for both halves of an edge (it depends only on the edge id). */
  private edgeColor(e: number): number {
    const { eUp, eDown, eDotted, rowCommit } = this.g;
    const d = eDown[e];
    return this.colors.edgeColor(rowCommit[eUp[e]], d < 0 ? -1 : rowCommit[d], eDotted[e] === 1);
  }

  getRow(row: number): GraphRow {
    const cached = this.rowCache.get(row);
    if (cached) return cached;
    const g = this.g;
    const { eUp, eDown, eDotted } = g;
    const elems = this.sortedElements(row);
    const upElems = row > 0 ? this.sortedElements(row - 1) : null;
    const downElems = row < g.rows - 1 ? this.sortedElements(row + 1) : null;

    const downPos = (e: number): number => {
      if (!downElems) return -1;
      let i = downElems.indexOf(e);
      if (i < 0 && eDown[e] === row + 1) i = downElems.indexOf(~(row + 1));
      return i;
    };
    const upPos = (e: number): number => {
      if (!upElems) return -1;
      let i = upElems.indexOf(e);
      if (i < 0 && eUp[e] === row - 1) i = upElems.indexOf(~(row - 1));
      return i;
    };

    const edges: GraphEdgeElement[] = [];
    const arrows: GraphArrowElement[] = [];
    let nodeLane = 0;
    let maxLane = 0;
    const pushEdge = (dir: 'up' | 'down', lane: number, otherLane: number, e: number) => {
      edges.push({ dir, lane, otherLane, color: this.edgeColor(e), dotted: eDotted[e] === 1 });
      const m = Math.max(lane, Math.floor((lane + otherLane) / 2)); // half-lane midpoints fit in the floor lane
      if (m > maxLane) maxLane = m;
    };

    for (let pos = 0; pos < elems.length; pos++) {
      const el = elems[pos];
      if (pos > maxLane) maxLane = pos;
      if (el < 0) {
        nodeLane = pos;
        for (let k = g.downStart[row]; k < g.downStart[row + 1]; k++) {
          const e = g.downEdges[k];
          const d = downPos(e);
          if (d >= 0) pushEdge('down', pos, d, e);
          else if (eDown[e] < 0 && !downElems) pushEdge('down', pos, pos, e); // not-loaded parent of last row: stub
        }
        for (let k = g.upStart[row]; k < g.upStart[row + 1]; k++) {
          const e = g.upEdges[k];
          const u = upPos(e);
          if (u >= 0) pushEdge('up', pos, u, e);
        }
      } else {
        const d = downPos(el);
        const u = upPos(el);
        const arrow = this.arrowType(el, row);
        if (d >= 0) pushEdge('down', pos, d, el);
        else if (arrow === Arrow.Down) arrows.push({ dir: 'down', lane: pos, color: this.edgeColor(el) });
        if (u >= 0) pushEdge('up', pos, u, el);
        else if (arrow === Arrow.Up) arrows.push({ dir: 'up', lane: pos, color: this.edgeColor(el) });
      }
    }

    const result: GraphRow = {
      commitIndex: g.rowCommit[row],
      nodeLane,
      nodeColor: this.colors.nodeColor(g.rowCommit[row]),
      laneCount: maxLane + 1,
      edges,
      arrows,
    };
    this.rowCache.set(row, result);
    return result;
  }
}
