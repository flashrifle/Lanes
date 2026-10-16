import type { GraphLayout, GraphOptions, GraphSortType, LogSnapshot, Ref } from '../../types';
import { GRAPH_COLOR_COUNT } from '../../types';
import { buildGraph } from '../index';

export function ref(name: string, index: number, extra: Partial<Ref> = {}): Ref {
  const type = extra.type ?? 'localBranch';
  const fullName =
    extra.fullName ?? (type === 'localBranch' ? `refs/heads/${name}` : type === 'remoteBranch' ? `refs/remotes/${name}` : type === 'tag' ? `refs/tags/${name}` : 'HEAD');
  return {
    name,
    fullName,
    type,
    hash: `h${index}`,
    index,
    remote: null,
    upstream: null,
    ahead: null,
    behind: null,
    upstreamGone: false,
    isCurrent: false,
    isFavorite: false,
    ...extra,
  };
}

export function snapshot(parents: number[][], opts: { timestamps?: number[]; refs?: Ref[] } = {}): LogSnapshot {
  const n = parents.length;
  return {
    snapshotId: 1,
    repoPath: '/tmp/x',
    scope: { refs: null, limit: null },
    commitCount: n,
    hashes: parents.map((_, i) => `h${i}`),
    parents,
    timestamps: opts.timestamps ?? parents.map((_, i) => 1_000_000 - i * 60),
    refs: {
      head: { detached: false, unborn: false, branch: null, fullName: null, hash: null },
      refs: opts.refs ?? [],
      operation: null,
    },
    headIndex: null,
    truncated: false,
    loadMillis: 0,
  };
}

export function build(snap: LogSnapshot, o: Partial<GraphOptions> = {}): GraphLayout {
  return buildGraph(snap, { sortType: 'normal', visible: null, collapseLongEdges: true, ...o });
}

export function rowsOf(layout: GraphLayout) {
  const out = [];
  for (let r = 0; r < layout.rowCount; r++) out.push(layout.getRow(r));
  return out;
}

/** mulberry32 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random topo-ordered DAG (parents have larger indices), git-like: mostly first-parent chains,
 * some merges (incl. octopus), some far merges, some missing parents.
 */
export function randomSnapshot(n: number, seed: number, o: { mergeRate?: number; missingRate?: number; maxJump?: number } = {}): LogSnapshot {
  const rand = rng(seed);
  const mergeRate = o.mergeRate ?? 0.15;
  const missingRate = o.missingRate ?? 0.003;
  const maxJump = o.maxJump ?? 8;
  const parents: number[][] = [];
  for (let i = 0; i < n; i++) {
    const ps: number[] = [];
    const remaining = n - 1 - i;
    if (remaining > 0) {
      const jump = 1 + Math.floor(rand() * rand() * maxJump);
      ps.push(Math.min(n - 1, i + jump));
      if (rand() < mergeRate) {
        const far = rand() < 0.1 ? 200 : 40;
        ps.push(Math.min(n - 1, i + 1 + Math.floor(rand() * far)));
        if (rand() < 0.05) ps.push(Math.min(n - 1, i + 1 + Math.floor(rand() * far)));
      }
      if (rand() < missingRate) ps.push(-1);
    } else if (rand() < 0.5) ps.push(-1);
    parents.push(ps);
  }
  const refs: Ref[] = [];
  const refCount = Math.max(1, Math.floor(n / 50));
  for (let k = 0; k < refCount; k++) {
    const idx = Math.floor(rand() * Math.min(n, 300));
    const t = rand();
    refs.push(ref(`b${k}`, idx, { type: t < 0.5 ? 'localBranch' : t < 0.8 ? 'remoteBranch' : 'tag', isCurrent: k === 0 }));
  }
  const timestamps = parents.map((_, i) => 1_700_000_000 - i * 600 - Math.floor(rand() * 300));
  return snapshot(parents, { refs, timestamps });
}

/** Asserts the up/down pairing invariant + basic sanity; returns a description of the first violation or null. */
export function checkInvariant(layout: GraphLayout): string | null {
  const key = (lane: number, other: number, color: number, dotted: boolean) => `${lane}|${other}|${color}|${dotted ? 1 : 0}`;
  let prev: Map<string, number> | null = null; // down elements of previous row (as seen from row r)
  for (let r = 0; r < layout.rowCount; r++) {
    const row = layout.getRow(r);
    if (row.commitIndex !== layout.commitIndexAt(r)) return `row ${r}: commitIndex mismatch`;
    if (layout.rowOf(row.commitIndex) !== r) return `row ${r}: rowOf mismatch`;
    if (row.laneCount > layout.maxLaneCount) return `row ${r}: laneCount ${row.laneCount} > max ${layout.maxLaneCount}`;
    if (row.nodeLane >= row.laneCount) return `row ${r}: nodeLane out of laneCount`;
    if (row.nodeColor < 0 || row.nodeColor >= GRAPH_COLOR_COUNT) return `row ${r}: bad node color`;
    const ups = new Map<string, number>();
    const downs = new Map<string, number>();
    for (const e of row.edges) {
      if (e.color < 0 || e.color >= GRAPH_COLOR_COUNT) return `row ${r}: bad edge color`;
      if (e.lane >= row.laneCount) return `row ${r}: edge lane out of laneCount`;
      if (e.dir === 'up') {
        if (r === 0) return `row 0 has up edge`;
        const k = key(e.otherLane, e.lane, e.color, e.dotted); // as the matching 'down' in row r-1
        ups.set(k, (ups.get(k) ?? 0) + 1);
      } else {
        const k = key(e.lane, e.otherLane, e.color, e.dotted);
        downs.set(k, (downs.get(k) ?? 0) + 1);
      }
    }
    if (prev) {
      for (const [k, c] of prev) if (ups.get(k) !== c) return `row ${r}: down ${k} x${c} in row ${r - 1} has ${ups.get(k) ?? 0} matching up`;
      for (const [k, c] of ups) if (prev.get(k) !== c) return `row ${r}: up ${k} x${c} has ${prev.get(k) ?? 0} matching down in row ${r - 1}`;
    }
    prev = r === layout.rowCount - 1 ? null : downs;
  }
  return null;
}

export const SORTS: GraphSortType[] = ['normal', 'bek', 'linearBek'];
