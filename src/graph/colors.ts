// Fragment colors.
//
// Port of GraphColorGetterByHead (+ the default color manager idea) from JetBrains
// intellij-community `platform/vcs-log/graph` (com.intellij.vcs.log.graph.impl.print).
// Copyright 2000-2024 JetBrains s.r.o. and contributors.
// Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
// Modifications: TypeScript port; colors are palette indices; the pinned fragment
// (current branch, else main/master) always gets color 0 and all other fragments use 1..15.

import { GRAPH_COLOR_COUNT } from '../types';
import { headOrderOf, type GraphLayoutData } from './layout';

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // final avalanche
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

export type ColorOfLayout = (layoutIndex: number) => number;

/**
 * @param headKey stable key for a head commit: best ref fullName, else commit hash.
 * @param pinnedLayout layout index pinned to color 0 (or -1).
 */
export function createColorGetter(
  layout: GraphLayoutData,
  headKey: (commit: number) => string,
  pinnedLayout: number,
): ColorOfLayout {
  const memo = new Map<number, number>();
  const others = GRAPH_COLOR_COUNT - 1;
  return (li: number) => {
    let c = memo.get(li);
    if (c !== undefined) return c;
    if (li === pinnedLayout) c = 0;
    else if (layout.heads.length === 0) c = 1 + (fnv1a(String(li)) % others);
    else {
      const ho = headOrderOf(layout, li);
      const head = layout.heads[ho];
      const headLi = layout.headLayout[ho];
      const key = headKey(head);
      c = 1 + (fnv1a(li === headLi ? key : `${key}#${li - headLi}`) % others);
    }
    memo.set(li, c);
    return c;
  };
}
