// Visible (sorted + filtered) linear graph in row space.
//
// Filtering follows the idea of DottedFilterEdgesGenerator from JetBrains intellij-community
// `platform/vcs-log/graph` (com.intellij.vcs.log.graph.collapsing): hidden commits are removed
// and remaining commits are connected with DOTTED edges.
// Copyright 2000-2014 JetBrains s.r.o.
// Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// Modifications: simplified "reach" algorithm instead of the up/down walk: a visible node is
// connected to the (deduped, capped) set of nearest visible ancestors reachable through hidden
// commits. No transitive reduction.

import type { CommitGraph } from './commitGraph';

const REACH_CAP = 8;

export interface VisibleGraph {
  readonly rows: number;
  readonly rowCommit: Int32Array; // row -> snapshot index
  readonly commitRow: Int32Array; // snapshot index -> row (-1 hidden)
  // edges (row space). eDown = -1 => "not loaded" special edge going down from eUp.
  readonly edgeCount: number;
  readonly eUp: Int32Array;
  readonly eDown: Int32Array;
  readonly eDotted: Uint8Array;
  // node adjacency (edge ids): edges going down from row r, edges coming from above into row r
  readonly downStart: Int32Array;
  readonly downEdges: Int32Array;
  readonly upStart: Int32Array;
  readonly upEdges: Int32Array;
}

export function buildVisibleGraph(g: CommitGraph, order: Int32Array, visible: Uint8Array | null): VisibleGraph {
  const n = g.n;
  const isVisible = (c: number) => visible === null || visible[c] === 1;

  const commitRow = new Int32Array(n).fill(-1);
  let rows = 0;
  for (let i = 0; i < n; i++) if (isVisible(order[i])) rows++;
  const rowCommit = new Int32Array(rows);
  {
    let r = 0;
    for (let i = 0; i < n; i++) {
      const c = order[i];
      if (isVisible(c)) {
        rowCommit[r] = c;
        commitRow[c] = r++;
      }
    }
  }

  // reach sets for hidden commits, computed bottom-up in sorted order
  const reach: (Int32Array | undefined)[] | null = visible === null ? null : new Array(n);
  if (reach) {
    const tmp: number[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const c = order[i];
      if (isVisible(c)) continue;
      tmp.length = 0;
      outer: for (let k = g.parentStart[c]; k < g.parentStart[c + 1]; k++) {
        const p = g.parents[k];
        if (isVisible(p)) {
          if (!tmp.includes(p)) tmp.push(p);
          if (tmp.length >= REACH_CAP) break;
        } else {
          const rp = reach[p];
          if (!rp) continue;
          for (let j = 0; j < rp.length; j++) {
            if (!tmp.includes(rp[j])) tmp.push(rp[j]);
            if (tmp.length >= REACH_CAP) break outer;
          }
        }
      }
      if (tmp.length > 0) reach[c] = Int32Array.from(tmp);
    }
  }

  const ups: number[] = [];
  const downs: number[] = [];
  const dotted: number[] = [];
  const stamp = new Int32Array(Math.max(rows, 1)).fill(-1);
  for (let r = 0; r < rows; r++) {
    const c = rowCommit[r];
    // solid edges first so they win over dotted duplicates
    for (let k = g.parentStart[c]; k < g.parentStart[c + 1]; k++) {
      const pr = commitRow[g.parents[k]];
      if (pr < 0 || pr === r || stamp[pr] === r) continue;
      stamp[pr] = r;
      ups.push(Math.min(r, pr));
      downs.push(Math.max(r, pr));
      dotted.push(0);
    }
    if (reach) {
      for (let k = g.parentStart[c]; k < g.parentStart[c + 1]; k++) {
        const rp = reach[g.parents[k]];
        if (!rp) continue;
        for (let j = 0; j < rp.length; j++) {
          const pr = commitRow[rp[j]];
          if (pr < 0 || pr === r || stamp[pr] === r) continue;
          stamp[pr] = r;
          ups.push(Math.min(r, pr));
          downs.push(Math.max(r, pr));
          dotted.push(1);
        }
      }
    }
    if (g.notLoaded[c]) {
      ups.push(r);
      downs.push(-1);
      dotted.push(0);
    }
  }

  const E = ups.length;
  const eUp = Int32Array.from(ups);
  const eDown = Int32Array.from(downs);
  const eDotted = Uint8Array.from(dotted);

  const downStart = new Int32Array(rows + 1);
  const upStart = new Int32Array(rows + 1);
  for (let e = 0; e < E; e++) {
    downStart[eUp[e] + 1]++;
    if (eDown[e] >= 0) upStart[eDown[e] + 1]++;
  }
  for (let r = 0; r < rows; r++) {
    downStart[r + 1] += downStart[r];
    upStart[r + 1] += upStart[r];
  }
  const downEdges = new Int32Array(downStart[rows]);
  const upEdges = new Int32Array(upStart[rows]);
  const df = downStart.slice(0, rows);
  const uf = upStart.slice(0, rows);
  for (let e = 0; e < E; e++) {
    downEdges[df[eUp[e]]++] = e;
    if (eDown[e] >= 0) upEdges[uf[eDown[e]]++] = e;
  }

  return { rows, rowCommit, commitRow, edgeCount: E, eUp, eDown, eDotted, downStart, downEdges, upStart, upEdges };
}
