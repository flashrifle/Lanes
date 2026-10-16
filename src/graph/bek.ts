// Bek sort ("Standard" sort of the IntelliJ log).
//
// Port of BekSorter / BekBranchCreator / BekBranch / BekBranchMerger / BekEdgeRestrictions
// from JetBrains intellij-community `platform/vcs-log/graph`
// (com.intellij.vcs.log.graph.impl.facade.sort.bek).
// Copyright 2000-2024 JetBrains s.r.o. and contributors.
// Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// Modifications: TypeScript port; iterative DFS; timestamps are unix seconds;
// the branch merger uses a binary heap + event-driven unblocking instead of a linear scan
// per step (same selection rule: min timestamp, ties -> lowest branch index).

import type { CommitGraph } from './commitGraph';
import type { GraphLayoutData } from './layout';

const MAX_BLOCK_SIZE = 20;
const MAX_DELTA_TIME = 60 * 60 * 24 * 3; // seconds
const SMALL_DELTA_TIME = 60 * 60 * 4; // seconds

class EdgeRestrictions {
  private readonly upCount: Int32Array;
  private readonly downToUps = new Map<number, number[]>();
  private readonly pairs = new Set<number>();
  private readonly n: number;

  constructor(n: number) {
    this.n = n;
    this.upCount = new Int32Array(n);
  }

  add(up: number, down: number): void {
    const key = up * this.n + down;
    if (this.pairs.has(key)) return;
    this.pairs.add(key);
    this.upCount[up]++;
    const l = this.downToUps.get(down);
    if (l) l.push(up);
    else this.downToUps.set(down, [up]);
  }

  /** removes all restrictions pointing at `down`; reports up nodes whose count dropped to 0 */
  remove(down: number, onFree: (up: number) => void): void {
    const l = this.downToUps.get(down);
    if (!l) return;
    this.downToUps.delete(down);
    for (const up of l) {
      this.pairs.delete(up * this.n + down);
      if (--this.upCount[up] === 0) onFree(up);
    }
  }

  has(up: number): boolean {
    return this.upCount[up] > 0;
  }
}

function createBranches(g: CommitGraph, layout: GraphLayoutData, restrictions: EdgeRestrictions): Int32Array[] {
  const n = g.n;
  const li = layout.layoutIndex;
  const { parentStart, parents, childStart, children } = g;
  const done = new Uint8Array(n);
  const stack = new Int32Array(n + 1);
  const branches: Int32Array[] = [];
  const buf: number[] = [];

  for (let h = 0; h < layout.heads.length; h++) {
    const head = layout.heads[h];
    if (done[head]) continue;
    done[head] = 1;
    buf.length = 0;
    buf.push(head);
    const startLayout = li[head];
    let sp = 0;
    stack[sp++] = head;
    while (sp > 0) {
      const cur = stack[sp - 1];
      const curLayout = li[cur];
      let next = -1;
      for (let k = parentStart[cur + 1] - 1; k >= parentStart[cur]; k--) {
        const down = parents[k];
        if (done[down]) {
          if (li[down] < startLayout) restrictions.add(cur, down);
        } else if (curLayout <= li[down]) {
          let hasUndoneUp = false;
          for (let j = childStart[down]; j < childStart[down + 1]; j++) {
            const up = children[j];
            if (!done[up] && li[up] <= li[down]) {
              hasUndoneUp = true;
              break;
            }
          }
          if (!hasUndoneUp) {
            done[down] = 1;
            buf.push(down);
            next = down;
            break;
          }
        }
      }
      if (next < 0) sp--;
      else stack[sp++] = next;
    }
    branches.push(Int32Array.from(buf));
  }
  return branches;
}

function hasParent(g: CommitGraph, node: number, parent: number): boolean {
  for (let k = g.parentStart[node]; k < g.parentStart[node + 1]; k++) if (g.parents[k] === parent) return true;
  return false;
}

/** Returns new order (row -> commit) or null if something went wrong. */
export function bekSort(g: CommitGraph, layout: GraphLayoutData, timestamps: readonly number[]): Int32Array | null {
  const n = g.n;
  if (n === 0) return new Int32Array(0);
  const restrictions = new EdgeRestrictions(n);
  const branches = createBranches(g, layout, restrictions);
  const B = branches.length;
  const ts = (c: number) => timestamps[c] ?? 0;

  const noInsert = new Int32Array(B);
  const partStart = new Int32Array(B).fill(-1); // -1 = no prepared part
  for (let b = 0; b < B; b++) noInsert[b] = branches[b].length;

  // blocked branches keyed by their current last node
  const blockedByNode = new Map<number, number>();

  const prepare = (b: number): boolean => {
    const nodes = branches[b];
    const size = noInsert[b];
    const currentNode = nodes[size - 1];
    if (restrictions.has(currentNode)) {
      blockedByNode.set(currentNode, b);
      return false;
    }
    let prev: number;
    for (prev = size - 1; prev > 0; prev--) {
      const up = nodes[prev - 1];
      const down = nodes[prev];
      if (restrictions.has(up)) break;
      const upDeg = g.parentStart[up + 1] - g.parentStart[up];
      const contains = hasParent(g, up, down);
      if (upDeg > 1 && contains) continue;
      if (!contains) break;
      const delta = Math.abs(ts(up) - ts(down));
      if (delta > MAX_DELTA_TIME) break;
      if (prev < size - MAX_BLOCK_SIZE && delta > SMALL_DELTA_TIME) break;
    }
    partStart[b] = prev;
    return true;
  };

  // min-heap of (timestamp, branch)
  const heapTs: number[] = [];
  const heapB: number[] = [];
  const less = (i: number, j: number) => heapTs[i] < heapTs[j] || (heapTs[i] === heapTs[j] && heapB[i] < heapB[j]);
  const swap = (i: number, j: number) => {
    const t = heapTs[i]; heapTs[i] = heapTs[j]; heapTs[j] = t;
    const x = heapB[i]; heapB[i] = heapB[j]; heapB[j] = x;
  };
  const push = (b: number) => {
    heapTs.push(ts(branches[b][partStart[b]]));
    heapB.push(b);
    let i = heapTs.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(i, p)) break;
      swap(i, p);
      i = p;
    }
  };
  const pop = (): number => {
    const top = heapB[0];
    const lastTs = heapTs.pop()!;
    const lastB = heapB.pop()!;
    if (heapTs.length > 0) {
      heapTs[0] = lastTs;
      heapB[0] = lastB;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heapTs.length && less(l, m)) m = l;
        if (r < heapTs.length && less(r, m)) m = r;
        if (m === i) break;
        swap(i, m);
        i = m;
      }
    }
    return top;
  };

  for (let b = 0; b < B; b++) if (noInsert[b] > 0 && prepare(b)) push(b);

  const inverse = new Int32Array(n);
  let w = 0;
  const unblocked: number[] = [];
  const onFree = (up: number) => {
    const b = blockedByNode.get(up);
    if (b !== undefined) {
      blockedByNode.delete(up);
      unblocked.push(b);
    }
  };

  while (heapTs.length > 0) {
    const b = pop();
    const nodes = branches[b];
    const start = partStart[b];
    const end = noInsert[b];
    for (let k = start; k < end; k++) restrictions.remove(nodes[k], onFree);
    for (let k = end - 1; k >= start; k--) {
      if (w >= n) return null;
      inverse[w++] = nodes[k];
    }
    noInsert[b] = start;
    partStart[b] = -1;
    if (start > 0) unblocked.push(b);
    // same as IntelliJ: prepare parts after all removals of this step, in branch order
    if (unblocked.length > 0) {
      unblocked.sort((x, y) => x - y);
      for (const ub of unblocked) if (noInsert[ub] > 0 && partStart[ub] < 0 && prepare(ub)) push(ub);
      unblocked.length = 0;
    }
  }

  if (w !== n) return null;
  const result = new Int32Array(n);
  for (let i = 0; i < n; i++) result[i] = inverse[n - 1 - i];
  // verify permutation
  const seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (seen[result[i]]) return null;
    seen[result[i]] = 1;
  }
  return result;
}
