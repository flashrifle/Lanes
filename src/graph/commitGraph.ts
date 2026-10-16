// Permanent commit graph in snapshot-index space, stored as CSR Int32Arrays.
//
// Port (simplified) of PermanentLinearGraphBuilder / DuplicateParentFixer from
// JetBrains intellij-community `platform/vcs-log/graph`.
// Copyright 2000-2024 JetBrains s.r.o. and contributors.
// Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// Modifications: rewritten in TypeScript for git-log-viewer.

export interface CommitGraph {
  readonly n: number;
  /** parents of c (loaded only, deduped, git parent order): parents[parentStart[c] .. parentStart[c+1]) */
  readonly parentStart: Int32Array;
  readonly parents: Int32Array;
  /** 1 if commit has at least one parent that is not in the snapshot (-1) */
  readonly notLoaded: Uint8Array;
  /** children of c (ascending index): children[childStart[c] .. childStart[c+1]) */
  readonly childStart: Int32Array;
  readonly children: Int32Array;
}

export function buildCommitGraph(n: number, rawParents: readonly (readonly number[])[]): CommitGraph {
  const parentStart = new Int32Array(n + 1);
  const notLoaded = new Uint8Array(n);
  const stamp = new Int32Array(n).fill(-1);

  // pass 1: count deduped loaded parents
  let total = 0;
  for (let c = 0; c < n; c++) {
    parentStart[c] = total;
    const ps = rawParents[c] ?? [];
    for (let k = 0; k < ps.length; k++) {
      const p = ps[k];
      if (!(p >= 0 && p < n) || p === c) {
        if (p !== c) notLoaded[c] = 1;
        continue;
      }
      if (stamp[p] === c) continue;
      stamp[p] = c;
      total++;
    }
  }
  parentStart[n] = total;

  const parents = new Int32Array(total);
  const childCount = new Int32Array(n + 1);
  stamp.fill(-1);
  let w = 0;
  for (let c = 0; c < n; c++) {
    const ps = rawParents[c] ?? [];
    for (let k = 0; k < ps.length; k++) {
      const p = ps[k];
      if (!(p >= 0 && p < n) || p === c || stamp[p] === c) continue;
      stamp[p] = c;
      parents[w++] = p;
      childCount[p]++;
    }
  }

  const childStart = new Int32Array(n + 1);
  for (let c = 0; c < n; c++) childStart[c + 1] = childStart[c] + childCount[c];
  const children = new Int32Array(total);
  const fill = childStart.slice(0, n);
  for (let c = 0; c < n; c++) {
    for (let k = parentStart[c]; k < parentStart[c + 1]; k++) {
      const p = parents[k];
      children[fill[p]++] = c;
    }
  }

  return { n, parentStart, parents, notLoaded, childStart, children };
}
