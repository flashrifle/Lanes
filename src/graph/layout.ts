// Layout indices ("fragments") for the permanent graph.
//
// Port of GraphLayoutBuilder / GraphLayoutImpl from JetBrains intellij-community
// `platform/vcs-log/graph` (com.intellij.vcs.log.graph.impl.permanent).
// Copyright 2000-2024 JetBrains s.r.o. and contributors.
// Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// Modifications: TypeScript port; DFS is iterative over an Int32Array stack; head
// comparator implemented from git-log-viewer ref priorities.

import type { Ref } from '../types';
import type { CommitGraph } from './commitGraph';

export interface GraphLayoutData {
  /** layout index per commit (>= 1) */
  readonly layoutIndex: Int32Array;
  /** "important" heads in the order they were walked */
  readonly heads: Int32Array;
  /** layoutIndex of each important head (strictly increasing) */
  readonly headLayout: Int32Array;
}

export interface HeadInfo {
  /** candidate heads sorted by priority */
  readonly sortedHeads: Int32Array;
  /** best ref fullName per commit (only commits with refs) */
  readonly refKey: Map<number, string>;
  /** commit whose fragment is pinned to color 0, or -1 */
  readonly pinnedCommit: number;
}

const RANK_NONE = 127;

function refRank(r: Ref): number {
  if (r.isCurrent) return 0;
  if (r.isFavorite) return 1;
  switch (r.type) {
    case 'head': return 0;
    case 'localBranch': return 2;
    case 'remoteBranch': return 3;
    case 'tag': return 4;
  }
  return 5;
}

/** Priority used to pick the ref that names a head (for colors); 'HEAD' itself is last resort. */
function refKeyRank(r: Ref): number {
  if (r.type === 'head') return 10;
  return refRank(r);
}

/**
 * Head priority: current branch > favorites > other local > remote > tags > childless commits;
 * ties by snapshot index.
 */
export function computeHeads(g: CommitGraph, refs: readonly Ref[]): HeadInfo {
  const n = g.n;
  const rank = new Uint8Array(n).fill(RANK_NONE);
  const refKey = new Map<number, string>();
  const keyRank = new Map<number, number>();
  let currentBranchCommit = -1;
  let mainCommit = -1;
  let masterCommit = -1;

  for (const r of refs) {
    const c = r.index;
    if (c == null || !(c >= 0 && c < n)) continue;
    const rr = refRank(r);
    if (rr < rank[c]) rank[c] = rr;
    const kr = refKeyRank(r);
    const prev = keyRank.get(c);
    if (prev === undefined || kr < prev) {
      keyRank.set(c, kr);
      refKey.set(c, r.fullName);
    }
    if (r.type === 'localBranch' && r.isCurrent) currentBranchCommit = c;
    if (r.fullName === 'refs/heads/main') mainCommit = c;
    if (r.fullName === 'refs/heads/master') masterCommit = c;
  }

  const cand: number[] = [];
  for (let c = 0; c < n; c++) {
    if (rank[c] === RANK_NONE && g.childStart[c] === g.childStart[c + 1]) rank[c] = 5;
    if (rank[c] !== RANK_NONE) cand.push(c);
  }
  cand.sort((a, b) => rank[a] - rank[b] || a - b);

  const pinnedCommit = currentBranchCommit >= 0 ? currentBranchCommit : mainCommit >= 0 ? mainCommit : masterCommit;
  return { sortedHeads: Int32Array.from(cand), refKey, pinnedCommit };
}

export function buildLayout(g: CommitGraph, sortedHeads: Int32Array): GraphLayoutData {
  const n = g.n;
  const { parentStart, parents } = g;
  const layoutIndex = new Int32Array(n);
  const scan = new Int32Array(n); // per-node pointer into its parent list (layoutIndex only goes 0 -> nonzero)
  const stack = new Int32Array(n + 1);
  const heads: number[] = [];

  let current = 1;
  for (let h = 0; h < sortedHeads.length; h++) {
    const head = sortedHeads[h];
    if (layoutIndex[head] !== 0) continue;
    heads.push(head);
    let sp = 0;
    stack[sp++] = head;
    while (sp > 0) {
      const node = stack[sp - 1];
      const firstVisit = layoutIndex[node] === 0;
      if (firstVisit) layoutIndex[node] = current;
      const end = parentStart[node + 1];
      let k = parentStart[node] + scan[node];
      while (k < end && layoutIndex[parents[k]] !== 0) k++;
      scan[node] = k - parentStart[node];
      if (k === end) {
        if (firstVisit) current++;
        sp--;
      } else {
        stack[sp++] = parents[k];
      }
    }
  }

  // Safety: every node is reachable from a childless node, but guard anyway.
  for (let c = 0; c < n; c++) if (layoutIndex[c] === 0) layoutIndex[c] = current++;

  const headsArr = Int32Array.from(heads);
  const headLayout = new Int32Array(headsArr.length);
  for (let i = 0; i < headsArr.length; i++) headLayout[i] = layoutIndex[headsArr[i]];
  return { layoutIndex, heads: headsArr, headLayout };
}

/** GraphLayoutImpl.getHeadOrder: index of the head whose fragment block contains layoutIndex. */
export function headOrderOf(layout: GraphLayoutData, li: number): number {
  const a = layout.headLayout;
  let lo = 0;
  let hi = a.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= li) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
