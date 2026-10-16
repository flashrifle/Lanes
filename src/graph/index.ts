// Commit graph engine: TypeScript port of the JetBrains IntelliJ vcs-log graph
// (intellij-community `platform/vcs-log/graph`, Apache-2.0). See individual files for attribution.
//
// Pipeline: CommitGraph (CSR) -> heads + GraphLayout (layout indices) -> sort (normal | bek)
// -> visible graph (filter with dotted edges) -> lazy PrintElementGenerator rows.

import type { GraphLayout, GraphOptions, GraphRow, LogSnapshot } from '../types';
import { bekSort } from './bek';
import { createColorGetter } from './colors';
import { buildCommitGraph } from './commitGraph';
import { buildLayout, computeHeads } from './layout';
import { PrintElementGenerator } from './printElements';
import { buildVisibleGraph } from './visibleGraph';

export { LONG_EDGE_SIZE } from './printElements';

export function buildGraph(snapshot: LogSnapshot, options: GraphOptions): GraphLayout {
  const n = snapshot.commitCount;
  const g = buildCommitGraph(n, snapshot.parents);
  const heads = computeHeads(g, snapshot.refs?.refs ?? []);
  const layout = buildLayout(g, heads.sortedHeads);

  let order: Int32Array | null = null;
  if (options.sortType === 'bek' || options.sortType === 'linearBek') {
    // linearBek (IntelliSort) is not implemented: falls back to bek.
    order = bekSort(g, layout, snapshot.timestamps);
  }
  if (!order) {
    order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
  }

  const visible = options.visible && options.visible.length >= n ? options.visible : null;
  const vg = buildVisibleGraph(g, order, visible);

  const rowLayout = new Int32Array(vg.rows);
  for (let r = 0; r < vg.rows; r++) rowLayout[r] = layout.layoutIndex[vg.rowCommit[r]];

  const pinnedLayout = heads.pinnedCommit >= 0 ? layout.layoutIndex[heads.pinnedCommit] : -1;
  const colorOf = createColorGetter(
    layout,
    (c) => heads.refKey.get(c) ?? snapshot.hashes[c] ?? String(c),
    pinnedLayout,
  );

  const gen = new PrintElementGenerator(vg, rowLayout, colorOf, options.collapseLongEdges);
  const rowCount = vg.rows;

  const checkRow = (row: number) => {
    if (!(row >= 0 && row < rowCount) || !Number.isInteger(row)) throw new RangeError(`row ${row} out of range [0, ${rowCount})`);
  };

  return {
    rowCount,
    maxLaneCount: gen.maxLaneCount,
    getRow(row: number): GraphRow {
      checkRow(row);
      return gen.getRow(row);
    },
    commitIndexAt(row: number): number {
      checkRow(row);
      return vg.rowCommit[row];
    },
    rowOf(commitIndex: number): number {
      return commitIndex >= 0 && commitIndex < n ? vg.commitRow[commitIndex] : -1;
    },
  };
}
