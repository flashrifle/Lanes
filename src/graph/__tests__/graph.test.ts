import { describe, expect, it } from 'vitest';
import { build, checkInvariant, randomSnapshot, ref, rowsOf, snapshot, SORTS } from './helpers';

const lanes = (l: ReturnType<typeof build>) => rowsOf(l).map((r) => r.nodeLane);

describe('basic layouts', () => {
  it('empty snapshot', () => {
    const l = build(snapshot([]));
    expect(l.rowCount).toBe(0);
    expect(l.maxLaneCount).toBe(0);
    expect(() => l.getRow(0)).toThrow(RangeError);
  });

  it('linear history', () => {
    const l = build(snapshot([[1], [2], [3], []]));
    expect(l.rowCount).toBe(4);
    expect(l.maxLaneCount).toBe(1);
    const rows = rowsOf(l);
    expect(lanes(l)).toEqual([0, 0, 0, 0]);
    expect(rows[0].edges).toEqual([{ dir: 'down', lane: 0, otherLane: 0, color: rows[0].nodeColor, dotted: false }]);
    expect(rows[1].edges.map((e) => e.dir).sort()).toEqual(['down', 'up']);
    expect(rows[3].edges.map((e) => e.dir)).toEqual(['up']);
    expect(new Set(rows.map((r) => r.nodeColor)).size).toBe(1);
    expect(rows.every((r) => r.arrows.length === 0 && r.laneCount === 1)).toBe(true);
    expect(checkInvariant(l)).toBeNull();
  });

  it('branch + merge diamond', () => {
    // 0 = merge(1, 2); 1 -> 3; 2 -> 3
    const l = build(snapshot([[1, 2], [3], [3], []]));
    expect(lanes(l)).toEqual([0, 0, 1, 0]);
    expect(l.maxLaneCount).toBe(2);
    const rows = rowsOf(l);
    // row 0: merge goes down to lane 0 (first parent) and lane 1 (passing edge to 2)
    expect(rows[0].edges.filter((e) => e.dir === 'down').map((e) => e.otherLane).sort()).toEqual([0, 1]);
    // the side branch has its own color, used by the edges that belong to it
    const sideColor = rows[2].nodeColor;
    const mergeEdge = rows[0].edges.find((e) => e.otherLane === 1)!;
    expect(mergeEdge.color).toBe(sideColor);
    expect(rows[1].laneCount).toBe(2);
    expect(checkInvariant(l)).toBeNull();
  });

  it('octopus merge', () => {
    const l = build(snapshot([[1, 2, 3], [4], [4], [4], []]));
    expect(lanes(l)).toEqual([0, 0, 1, 2, 0]);
    expect(l.maxLaneCount).toBe(3);
    expect(rowsOf(l)[0].edges.filter((e) => e.dir === 'down').length).toBe(3);
    expect(rowsOf(l)[4].edges.filter((e) => e.dir === 'up').length).toBe(3);
    expect(checkInvariant(l)).toBeNull();
  });

  it('criss-cross merge', () => {
    // 0 = merge(2, 3); 1 = merge(3, 2); 2 -> 4; 3 -> 4
    const l = build(snapshot([[2, 3], [3, 2], [4], [4], []]));
    expect(checkInvariant(l)).toBeNull();
    const rows = rowsOf(l);
    expect(rows[0].edges.filter((e) => e.dir === 'down').length).toBe(2);
    expect(rows[1].edges.filter((e) => e.dir === 'down' && e.lane === rows[1].nodeLane).length).toBe(2);
    expect(rows[4].edges.filter((e) => e.dir === 'up').length).toBe(2);
    for (const s of SORTS) expect(checkInvariant(build(snapshot([[2, 3], [3, 2], [4], [4], []]), { sortType: s }))).toBeNull();
  });

  it('duplicate parents are ignored', () => {
    const l = build(snapshot([[1, 1], []]));
    expect(rowsOf(l)[0].edges.length).toBe(1);
  });
});

describe('missing parents', () => {
  it('not-loaded parent shows a down arrow in the next row', () => {
    // 0 has parents 1 and a missing one
    const l = build(snapshot([[1, -1], [2], []]));
    const rows = rowsOf(l);
    expect(rows[0].edges.filter((e) => e.dir === 'down').length).toBe(2);
    expect(rows[1].arrows).toEqual([{ dir: 'down', lane: 1, color: rows[0].nodeColor }]);
    expect(rows[1].laneCount).toBe(2);
    expect(l.maxLaneCount).toBe(2);
    expect(checkInvariant(l)).toBeNull();
  });

  it('not-loaded parent of the last row draws a stub', () => {
    const l = build(snapshot([[1], [-1]]));
    const last = l.getRow(1);
    expect(last.edges.filter((e) => e.dir === 'down')).toEqual([{ dir: 'down', lane: 0, otherLane: 0, color: last.nodeColor, dotted: false }]);
    expect(checkInvariant(l)).toBeNull();
  });
});

describe('filter mask', () => {
  it('connects visible commits through hidden ones with dotted edges', () => {
    const snap = snapshot([[1], [2], [3], [4], []]);
    const visible = Uint8Array.from([1, 0, 1, 0, 1]);
    const l = build(snap, { visible });
    expect(l.rowCount).toBe(3);
    expect([0, 1, 2].map((r) => l.commitIndexAt(r))).toEqual([0, 2, 4]);
    expect(l.rowOf(1)).toBe(-1);
    expect(l.rowOf(4)).toBe(2);
    const rows = rowsOf(l);
    expect(rows[0].edges).toEqual([{ dir: 'down', lane: 0, otherLane: 0, color: rows[0].nodeColor, dotted: true }]);
    expect(rows[1].edges.every((e) => e.dotted)).toBe(true);
    expect(checkInvariant(l)).toBeNull();
  });

  it('keeps solid edges between adjacent visible commits', () => {
    const l = build(snapshot([[1], [2], [3], []]), { visible: Uint8Array.from([1, 1, 0, 1]) });
    const rows = rowsOf(l);
    expect(rows[0].edges[0].dotted).toBe(false);
    expect(rows[1].edges.find((e) => e.dir === 'down')!.dotted).toBe(true);
    expect(checkInvariant(l)).toBeNull();
  });

  it('hidden side branch of a merge becomes a dotted edge; solid wins over duplicate dotted', () => {
    // 0 = merge(1, 2); 2 -> 3 -> 1? no: 2 -> 3, 3 -> 4, 1 -> 4
    const snap = snapshot([[1, 2], [4], [3], [4], []]);
    const l = build(snap, { visible: Uint8Array.from([1, 1, 0, 0, 1]) });
    expect(l.rowCount).toBe(3);
    const r0 = l.getRow(0);
    const downs = r0.edges.filter((e) => e.dir === 'down');
    // edge to 1 (solid) and dotted edge to 4 through 2,3
    expect(downs.length).toBe(2);
    expect(downs.filter((e) => e.dotted).length).toBe(1);
    expect(checkInvariant(l)).toBeNull();

    // when the hidden path leads to an already directly-connected parent, keep only the solid edge
    const l2 = build(snapshot([[1, 2], [3], [1], []]), { visible: Uint8Array.from([1, 1, 0, 1]) });
    expect(l2.getRow(0).edges.filter((e) => e.dir === 'down')).toHaveLength(1);
    expect(l2.getRow(0).edges[0].dotted).toBe(false);
  });

  it('empty mask yields no rows', () => {
    const l = build(snapshot([[1], []]), { visible: new Uint8Array(2) });
    expect(l.rowCount).toBe(0);
  });
});

describe('long edges', () => {
  // 0 = merge(1, 35); chain 1 -> 2 -> ... -> 39; 35 is on the chain
  const N = 40;
  const parents: number[][] = [];
  for (let i = 0; i < N; i++) parents.push(i === 0 ? [1, 35] : i < N - 1 ? [i + 1] : []);

  it('collapses edges >= 30 rows to their ends with arrows', () => {
    const l = build(snapshot(parents));
    const rows = rowsOf(l);
    expect(checkInvariant(l)).toBeNull();
    expect(rows[1].arrows).toHaveLength(1);
    expect(rows[1].arrows[0].dir).toBe('down');
    expect(rows[34].arrows).toHaveLength(1);
    expect(rows[34].arrows[0].dir).toBe('up');
    for (let r = 2; r <= 33; r++) {
      expect(rows[r].laneCount).toBe(1);
      expect(rows[r].arrows).toHaveLength(0);
    }
    expect(rows[1].laneCount).toBe(2);
    expect(rows[34].laneCount).toBe(2);
    expect(l.maxLaneCount).toBe(2);
  });

  it('shows full edges when collapseLongEdges = false', () => {
    const l = build(snapshot(parents), { collapseLongEdges: false });
    const rows = rowsOf(l);
    expect(checkInvariant(l)).toBeNull();
    expect(rows.every((r) => r.arrows.length === 0)).toBe(true);
    for (let r = 1; r <= 34; r++) expect(rows[r].laneCount).toBe(2);
  });
});

describe('colors', () => {
  it('pins the current branch to color 0 and is stable across rebuilds', () => {
    // two branches from a common base: 0 -> 2, 1 -> 2
    const refs = [ref('feature', 0), ref('main', 1, { isCurrent: true, isFavorite: true })];
    const snap = snapshot([[2], [2], []], { refs });
    const l = build(snap);
    expect(l.getRow(1).nodeColor).toBe(0);
    expect(l.getRow(2).nodeColor).toBe(0); // base belongs to the current branch fragment
    expect(l.getRow(0).nodeColor).not.toBe(0);
    // current branch lays out first => leftmost lane
    expect(l.getRow(1).nodeLane).toBe(0);
    expect(l.getRow(0).edges[0].otherLane).toBe(1);
    const l2 = build(snapshot([[2], [2], []], { refs }));
    expect(rowsOf(l2)).toEqual(rowsOf(l));
  });

  it('falls back to main when detached', () => {
    const refs = [ref('feature', 0), ref('main', 1, { isFavorite: true }), ref('HEAD', 0, { type: 'head', isCurrent: true })];
    const l = build(snapshot([[2], [2], []], { refs }));
    expect(l.getRow(1).nodeColor).toBe(0);
  });
});

describe('bek sort', () => {
  it('keeps a merged branch contiguous', () => {
    // date order interleaves main (m*) and feature (f*): M, f3, m3, f2, m2, f1, m1, m0
    //  idx:                                               0  1   2   3   4   5   6   7
    const parents = [[2, 1], [3], [4], [5], [6], [7], [7], []];
    const timestamps = parents.map((_, i) => 1_700_000_000 - i * 3600);
    const refs = [ref('main', 0, { isCurrent: true })];
    const snap = snapshot(parents, { timestamps, refs });
    const normal = build(snap);
    expect([...Array(8).keys()].map((r) => normal.commitIndexAt(r))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const bek = build(snap, { sortType: 'bek' });
    const order = [...Array(8).keys()].map((r) => bek.commitIndexAt(r));
    expect(order).toEqual([0, 1, 3, 5, 2, 4, 6, 7]);
    expect(checkInvariant(bek)).toBeNull();
    // linearBek falls back to bek
    const lin = build(snap, { sortType: 'linearBek' });
    expect([...Array(8).keys()].map((r) => lin.commitIndexAt(r))).toEqual(order);
  });

  it('produces a topologically valid permutation on random DAGs', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const snap = randomSnapshot(400, seed);
      const l = build(snap, { sortType: 'bek' });
      expect(l.rowCount).toBe(400);
      const seen = new Set<number>();
      for (let r = 0; r < l.rowCount; r++) seen.add(l.commitIndexAt(r));
      expect(seen.size).toBe(400);
      for (let c = 0; c < 400; c++) for (const p of snap.parents[c]) if (p >= 0) expect(l.rowOf(p)).toBeGreaterThan(l.rowOf(c));
    }
  });
});
