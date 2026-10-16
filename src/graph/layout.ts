// Layout indices ("fragments") for the permanent graph.
//
// Port of GraphLayoutBuilder / GraphLayoutImpl from JetBrains intellij-community
// `platform/vcs-log/graph` (com.intellij.vcs.log.graph.impl.permanent).
// Copyright 2000-2024 JetBrains s.r.o. and contributors.
// Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// Modifications: TypeScript port; DFS is iterative over an Int32Array stack; head
// comparator implemented from Lanes ref priorities.

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
}

/**
 * Branch layout priority, port of git4idea GitRefManager.GitBranchLayoutComparator:
 * origin/main|master > other remote branches > local main|master > other local branches > tags > HEAD.
 * (IntelliJ ranks CURRENT_BRANCH after tags, but its layout comparator never yields that type, so the
 * current branch is an ordinary local branch here too.) Favorites and the current branch do NOT affect
 * layout order -- putting the checked-out branch first lays e.g. a long-lived `dev` out before `main`
 * and makes Bek sort stack every GitHub-flow merge commit on top of each other.
 */
function layoutRank(r: Ref): number {
  switch (r.type) {
    case 'remoteBranch':
      return r.name === 'origin/main' || r.name === 'origin/master' ? 0 : 1;
    case 'localBranch':
      return r.name === 'main' || r.name === 'master' ? 2 : 3;
    case 'tag':
      return 4;
    case 'head':
      return 6;
  }
  return 7;
}

/** GitRefComparator: rank, then name. Negative if a goes first. */
function compareRefs(a: Ref, b: Ref): number {
  const d = layoutRank(a) - layoutRank(b);
  if (d !== 0) return d;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Head order (HeadCommitsComparator + RefsModel.getRefForHeadCommit): every commit carrying a ref and
 * every childless commit is a candidate head; each is represented by its best ref under the branch layout
 * comparator; heads with refs come first in that order, then ref-less heads by snapshot index.
 */
export function computeHeads(g: CommitGraph, refs: readonly Ref[]): HeadInfo {
  const n = g.n;
  const best = new Map<number, Ref>();

  for (const r of refs) {
    const c = r.index;
    if (c == null || !(c >= 0 && c < n)) continue;
    const prev = best.get(c);
    if (prev === undefined || compareRefs(r, prev) < 0) best.set(c, r);
  }

  const withRef: number[] = [];
  const noRef: number[] = [];
  for (let c = 0; c < n; c++) {
    if (best.has(c)) withRef.push(c);
    else if (g.childStart[c] === g.childStart[c + 1]) noRef.push(c);
  }
  withRef.sort((a, b) => compareRefs(best.get(a)!, best.get(b)!) || a - b);

  const sortedHeads = new Int32Array(withRef.length + noRef.length);
  sortedHeads.set(withRef, 0);
  sortedHeads.set(noRef, withRef.length);
  return { sortedHeads };
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
