import { describe, expect, it } from 'vitest';
import type { Ref } from '../../types';
import { build, checkInvariant, randomSnapshot, ref, rowsOf, snapshot, SORTS } from './helpers';

type Node = { name: string; parents: string[] };

/** nodes listed newest first (topological); returns snapshot inputs + name lookup */
function graphOf(nodes: Node[]) {
  const idx = new Map(nodes.map((n, i) => [n.name, i]));
  const parents = nodes.map((n) => n.parents.map((p) => idx.get(p)!));
  return { parents, at: (name: string) => idx.get(name)! };
}

const colorOfCommit = (l: ReturnType<typeof build>, c: number) => l.getRow(l.rowOf(c)).nodeColor;

/** colour of the edge from child row to parent row, read from the child's 'down' halves */
function edgeColor(l: ReturnType<typeof build>, child: number, parent: number): number {
  const r = l.rowOf(child);
  const pr = l.rowOf(parent);
  const row = l.getRow(r);
  if (pr === r + 1) {
    const prow = l.getRow(pr);
    const e = row.edges.find((x) => x.dir === 'down' && x.lane === row.nodeLane && x.otherLane === prow.nodeLane);
    return e!.color;
  }
  // non-adjacent: the up half at the parent row arriving at the parent's node
  const prow = l.getRow(pr);
  const ups = prow.edges.filter((x) => x.dir === 'up' && x.lane === prow.nodeLane);
  const downs = row.edges.filter((x) => x.dir === 'down' && x.lane === row.nodeLane).map((x) => x.color);
  const both = ups.map((x) => x.color).filter((c) => downs.includes(c));
  return both[0];
}

describe('line colours: GitHub flow (dev merged into main repeatedly, HEAD = dev)', () => {
  const DEV = 40;
  const MERGES = 10;
  const nodes: (Node & { ts: number })[] = [];
  for (let i = 0; i < DEV; i++) nodes.push({ name: `d${i}`, ts: 1_790_000_000 + i * 18000, parents: i ? [`d${i - 1}`] : [] });
  for (let j = 1; j <= MERGES; j++) {
    const second = 4 * j - 1;
    nodes.push({ name: `M${j}`, ts: 1_790_000_000 + second * 18000 + 600, parents: [j === 1 ? 'd0' : `M${j - 1}`, `d${second}`] });
  }
  nodes.sort((a, b) => b.ts - a.ts);
  const { parents, at } = graphOf(nodes);
  const timestamps = nodes.map((n) => n.ts);
  const refs = [
    ref('dev', at('d39'), { isCurrent: true }),
    ref('main', at(`M${MERGES}`), { isFavorite: true }),
    ref('origin/dev', at('d39'), { type: 'remoteBranch', remote: 'origin' }),
    ref('origin/main', at(`M${MERGES}`), { type: 'remoteBranch', remote: 'origin' }),
  ];

  for (const sortType of SORTS) {
    it(`one colour for dev, another for main (${sortType})`, () => {
      const l = build(snapshot(parents, { timestamps, refs }), { sortType });
      expect(checkInvariant(l)).toBeNull();
      const dev = new Set<number>();
      for (let i = 1; i < DEV; i++) dev.add(colorOfCommit(l, at(`d${i}`)));
      const main = new Set<number>();
      for (let j = 1; j <= MERGES; j++) main.add(colorOfCommit(l, at(`M${j}`)));
      expect(dev).toEqual(new Set([0])); // current branch pinned to 0
      expect(main.size).toBe(1);
      expect([...main][0]).not.toBe(0);
      // merge edges (Mj -> d(4j-1)) carry dev's colour; main's own first-parent edges carry main's
      for (let j = 1; j <= MERGES; j++) {
        expect(edgeColor(l, at(`M${j}`), at(`d${4 * j - 1}`))).toBe(0);
        if (j > 1) expect(edgeColor(l, at(`M${j}`), at(`M${j - 1}`))).toBe([...main][0]);
      }
    });
  }
});

describe('line colours: merged-and-deleted feature branches', () => {
  // main: m0 <- m1 <- M1(m1, a2) <- m2 <- M2(m2, b2); a1,a2 fork from m0; b1,b2 fork from m1
  const { parents, at } = graphOf([
    { name: 'M2', parents: ['m2', 'b2'] },
    { name: 'b2', parents: ['b1'] },
    { name: 'm2', parents: ['M1'] },
    { name: 'b1', parents: ['m1'] },
    { name: 'M1', parents: ['m1', 'a2'] },
    { name: 'a2', parents: ['a1'] },
    { name: 'a1', parents: ['m0'] },
    { name: 'm1', parents: ['m0'] },
    { name: 'm0', parents: [] },
  ]);
  const refs = [ref('main', at('M2'), { isCurrent: true, isFavorite: true })];

  it('each feature line has its own colour, different from main', () => {
    const l = build(snapshot(parents, { refs }));
    expect(checkInvariant(l)).toBeNull();
    const c = (n: string) => colorOfCommit(l, at(n));
    expect(['M2', 'm2', 'M1', 'm1', 'm0'].map(c)).toEqual([0, 0, 0, 0, 0]);
    expect(c('a1')).toBe(c('a2'));
    expect(c('b1')).toBe(c('b2'));
    expect(c('a1')).not.toBe(0);
    expect(c('b1')).not.toBe(0);
    expect(c('a1')).not.toBe(c('b1'));
    // fork edge (a1 -> m0) is the feature's colour; merge edge (M1 -> a2) too
    expect(edgeColor(l, at('a1'), at('m0'))).toBe(c('a1'));
    expect(edgeColor(l, at('M1'), at('a2'))).toBe(c('a1'));
    expect(edgeColor(l, at('M1'), at('m1'))).toBe(0);
  });

  it('two named branches never share a colour', () => {
    const refs2: Ref[] = [ref('main', at('M2'), { isFavorite: true }), ref('fa', at('a2')), ref('fb', at('b2'), { isCurrent: true })];
    const l = build(snapshot(parents, { refs: refs2 }));
    const c = (n: string) => colorOfCommit(l, at(n));
    expect(c('b2')).toBe(0);
    expect(new Set([c('M2'), c('a2'), c('b2')]).size).toBe(3);
  });
});

describe('line colours: refs', () => {
  it('local branch and its remote-tracking branch share a colour', () => {
    // origin/feature is behind feature: f1 <- f2 (feature), origin/feature = f1; main = m
    const { parents, at } = graphOf([
      { name: 'f2', parents: ['f1'] },
      { name: 'f1', parents: ['m'] },
      { name: 'm', parents: [] },
    ]);
    const refs = [
      ref('origin/feature', at('f1'), { type: 'remoteBranch', remote: 'origin' }),
      ref('feature', at('f2')),
      ref('main', at('m'), { isCurrent: true }),
    ];
    const l = build(snapshot(parents, { refs }));
    expect(colorOfCommit(l, at('f1'))).toBe(colorOfCommit(l, at('f2')));
    expect(colorOfCommit(l, at('m'))).toBe(0);
    expect(colorOfCommit(l, at('f1'))).not.toBe(0);
  });

  it('remote-only branches are their own lines', () => {
    const { parents, at } = graphOf([
      { name: 'x', parents: ['m'] },
      { name: 'y', parents: ['m'] },
      { name: 'm', parents: [] },
    ]);
    const refs = [
      ref('origin/x', at('x'), { type: 'remoteBranch', remote: 'origin' }),
      ref('origin/y', at('y'), { type: 'remoteBranch', remote: 'origin' }),
      ref('main', at('m'), { isCurrent: true }),
    ];
    const l = build(snapshot(parents, { refs }));
    expect(new Set(['x', 'y', 'm'].map((n) => colorOfCommit(l, at(n)))).size).toBe(3);
  });

  it('is deterministic: rebuild and reordered refs give identical rows', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const snap = randomSnapshot(300, seed);
      const a = rowsOf(build(snap, { sortType: 'bek' }));
      const b = rowsOf(build(snap, { sortType: 'bek' }));
      expect(b).toEqual(a);
      const reversed = { ...snap, refs: { ...snap.refs!, refs: [...snap.refs!.refs].reverse() } };
      const c = rowsOf(build(reversed, { sortType: 'bek' }));
      expect(c.map((r) => r.nodeColor)).toEqual(a.map((r) => r.nodeColor));
      expect(c.map((r) => r.edges.map((e) => e.color))).toEqual(a.map((r) => r.edges.map((e) => e.color)));
    }
  });

  it('node colour is the same across sort types', () => {
    const snap = randomSnapshot(300, 3);
    const byCommit = (sortType: (typeof SORTS)[number]) => {
      const l = build(snap, { sortType });
      return Array.from({ length: 300 }, (_, c) => colorOfCommit(l, c));
    };
    expect(byCommit('bek')).toEqual(byCommit('normal'));
  });
});
