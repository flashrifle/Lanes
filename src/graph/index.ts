// src/graph/index.ts — TEMPORARY STUB, replaced by graph-engine
import type { GraphLayout, GraphOptions, LogSnapshot } from '../types';
export function buildGraph(snapshot: LogSnapshot, options: GraphOptions): GraphLayout {
  const rows: number[] = [];
  for (let i = 0; i < snapshot.commitCount; i++) if (!options.visible || options.visible[i]) rows.push(i);
  const rowOfMap = new Map(rows.map((c, r) => [c, r]));
  return {
    rowCount: rows.length,
    maxLaneCount: 1,
    getRow: (r) => ({ commitIndex: rows[r], nodeLane: 0, nodeColor: 0, laneCount: 1, edges: [], arrows: [] }),
    commitIndexAt: (r) => rows[r],
    rowOf: (c) => rowOfMap.get(c) ?? -1,
  };
}
