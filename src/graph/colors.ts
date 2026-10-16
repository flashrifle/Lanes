// Line colours ("Metro" model): one colour per branch line.
//
// Unlike IntelliJ's GraphColorGetterByHead (colour per layout fragment), a colour here belongs to a
// logical branch line, so a long-lived branch keeps its colour no matter how often it is merged.
//
// 1. Ownership by first-parent chains. Refs are grouped into owners (a local branch and its
//    remote-tracking counterparts share one owner, e.g. `main` + `origin/main` -> "b:main"). Owners
//    claim commits in priority order: main/master (trunk) > current branch > favourites > local
//    branches > remote branches > tags > detached HEAD, ties by key. Each ref walks first parents from
//    its commit, claiming unowned commits, and stops at the first owned one. The trunk claims first so
//    the shared history below a fork belongs to main, not to whatever branch is checked out.
// 2. Unnamed lines. Commits are then scanned in snapshot (git --date-order, i.e. topological) order.
//    An unowned commit there is a ref-less tip: it claims its chain under `tip:<hash>`. For a merge M,
//    every unowned non-first parent P claims its chain under `merge:<hash of M>` (`#k` for octopus).
// 3. Colours. Named owners that own at least one commit get distinct colours in priority order: the
//    pinned owner (current branch, else main/master) gets 0, the rest 1, 2, ... wrapping inside 1..15.
//    Synthetic owners get fnv1a(key) % 16, probing forward to avoid the line they merge into, the line
//    they fork from, every named colour and the last few synthetic colours (relaxed when impossible).
//    Everything is a pure function of (parents, hashes, refs as a set): deterministic across reloads.
// 4. Node colour = owner colour. Edge child c -> parent p: first parent -> colour(c), otherwise
//    colour(p) (the line being merged in). Not-loaded parents: colour(c). Dotted (filtered) edges to an
//    ancestor a: colour(c) when a is on the same line as c's first parent, else colour(a).

import type { Ref } from '../types';
import { GRAPH_COLOR_COUNT } from '../types';
import type { CommitGraph } from './commitGraph';

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

export interface LineColors {
  /** owner (line) id per commit */
  readonly owner: Int32Array;
  /** colour per owner id */
  readonly ownerColor: Uint8Array;
  /** owner key per owner id ("b:main", "tag:v1", "merge:<hash>", "tip:<hash>") */
  readonly ownerKey: readonly string[];
  /** first parent per commit (from the raw parent list; -1 if none / not loaded) */
  readonly firstParent: Int32Array;
  nodeColor(commit: number): number;
  /** colour of the edge child -> parent (parent -1 = not loaded) */
  edgeColor(child: number, parent: number, dotted: boolean): number;
}

const TRUNK = new Set(['main', 'master']);
const RECENT = 3;

interface OwnerSpec {
  key: string;
  rank: number;
  refs: { ref: Ref; rank: number }[];
}

function stripRemote(r: Ref): string {
  if (r.remote && r.name.startsWith(r.remote + '/')) return r.name.slice(r.remote.length + 1);
  const i = r.name.indexOf('/');
  return i >= 0 ? r.name.slice(i + 1) : r.name;
}

/** Groups refs into named owners, sorted by claim priority. */
function namedOwners(refs: readonly Ref[], n: number): OwnerSpec[] {
  const locals = new Set<string>();
  const upstreamToLocal = new Map<string, string>();
  for (const r of refs) {
    if (r.type !== 'localBranch') continue;
    locals.add(r.name);
    if (r.upstream) {
      const prev = upstreamToLocal.get(r.upstream);
      if (prev === undefined || r.name < prev) upstreamToLocal.set(r.upstream, r.name);
    }
  }
  const owners = new Map<string, OwnerSpec>();
  for (const r of refs) {
    const c = r.index;
    if (c == null || !(c >= 0 && c < n)) continue;
    let key: string;
    let short: string | null = null;
    let rank: number;
    switch (r.type) {
      case 'localBranch':
        short = r.name;
        key = 'b:' + r.name;
        rank = r.isCurrent ? 1 : r.isFavorite ? 2 : 3;
        break;
      case 'remoteBranch': {
        const local = upstreamToLocal.get(r.fullName) ?? (locals.has(stripRemote(r)) ? stripRemote(r) : null);
        short = local ?? stripRemote(r);
        key = 'b:' + (local ?? r.name);
        rank = r.isFavorite ? 2 : 4;
        break;
      }
      case 'tag':
        key = 'tag:' + r.name;
        rank = r.isFavorite ? 2 : 5;
        break;
      default:
        key = 'HEAD';
        rank = 6;
    }
    if (short !== null && TRUNK.has(short)) rank = 0;
    let o = owners.get(key);
    if (!o) owners.set(key, (o = { key, rank, refs: [] }));
    o.rank = Math.min(o.rank, rank);
    o.refs.push({ ref: r, rank });
  }
  const list = [...owners.values()];
  for (const o of list) o.refs.sort((a, b) => a.rank - b.rank || cmp(a.ref.fullName, b.ref.fullName) || (a.ref.index ?? 0) - (b.ref.index ?? 0));
  list.sort((a, b) => a.rank - b.rank || cmp(a.key, b.key));
  return list;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function computeLineColors(
  g: CommitGraph,
  rawParents: readonly (readonly number[])[],
  hashes: readonly string[],
  refs: readonly Ref[],
): LineColors {
  const n = g.n;
  const { parentStart, parents } = g;
  const firstParent = new Int32Array(n).fill(-1);
  for (let c = 0; c < n; c++) {
    const p = rawParents[c]?.[0];
    if (p !== undefined && p >= 0 && p < n && p !== c) firstParent[c] = p;
  }

  const owner = new Int32Array(n).fill(-1);
  const ownerKey: string[] = [];
  const ownerSize: number[] = [];
  const ownerNamed: boolean[] = [];
  const ownerRank: number[] = [];
  const ownerTarget: number[] = []; // synthetic: owner of the merge commit (line merged into), else -1
  const ownerBase: number[] = []; // owner of the commit where the claim walk stopped (fork base), else -1

  const newOwner = (key: string, named: boolean, rank: number, target: number): number => {
    ownerKey.push(key);
    ownerSize.push(0);
    ownerNamed.push(named);
    ownerRank.push(rank);
    ownerTarget.push(target);
    ownerBase.push(-1);
    return ownerKey.length - 1;
  };
  const claim = (start: number, id: number) => {
    let c = start;
    let k = 0;
    while (c >= 0 && owner[c] < 0) {
      owner[c] = id;
      k++;
      c = firstParent[c];
    }
    ownerSize[id] += k;
    if (c >= 0 && ownerBase[id] < 0 && owner[c] !== id) ownerBase[id] = owner[c];
  };

  // 1. named lines
  let currentOwner = -1;
  for (const o of namedOwners(refs, n)) {
    const id = newOwner(o.key, true, o.rank, -1);
    for (const { ref } of o.refs) {
      claim(ref.index!, id);
      if (ref.type === 'localBranch' && ref.isCurrent) currentOwner = id;
    }
  }

  // 2. unnamed lines, in topological (snapshot) order
  const hashOf = (c: number) => hashes[c] ?? String(c);
  for (let c = 0; c < n; c++) {
    if (owner[c] < 0) claim(c, newOwner('tip:' + hashOf(c), false, 7, -1));
    const fp = firstParent[c];
    let k = 0;
    for (let i = parentStart[c]; i < parentStart[c + 1]; i++) {
      const p = parents[i];
      if (p === fp) continue;
      k++;
      if (owner[p] >= 0) continue;
      claim(p, newOwner(k === 1 ? 'merge:' + hashOf(c) : `merge:${hashOf(c)}#${k}`, false, 8, owner[c]));
    }
  }

  // 3. colours
  const count = ownerKey.length;
  const ownerColor = new Uint8Array(count);
  const assigned = new Uint8Array(count);
  let pinned = currentOwner >= 0 && ownerSize[currentOwner] > 0 ? currentOwner : -1;
  if (pinned < 0) {
    for (let id = 0; id < count && ownerNamed[id]; id++) {
      if (ownerRank[id] === 0 && ownerSize[id] > 0) {
        pinned = id;
        break;
      }
    }
  }
  const namedUsed = new Uint8Array(GRAPH_COLOR_COUNT);
  if (pinned >= 0) {
    ownerColor[pinned] = 0;
    assigned[pinned] = 1;
    namedUsed[0] = 1;
  }
  let seq = 0;
  for (let id = 0; id < count; id++) {
    if (!ownerNamed[id] || id === pinned || ownerSize[id] === 0) continue;
    const c = pinned >= 0 ? 1 + (seq % (GRAPH_COLOR_COUNT - 1)) : seq % GRAPH_COLOR_COUNT;
    seq++;
    ownerColor[id] = c;
    assigned[id] = 1;
    namedUsed[c] = 1;
  }

  const recent: number[] = [];
  const avoid = new Uint8Array(GRAPH_COLOR_COUNT);
  const probe = (h: number): number => {
    for (let i = 0; i < GRAPH_COLOR_COUNT; i++) {
      const c = (h + i) % GRAPH_COLOR_COUNT;
      if (!avoid[c]) return c;
    }
    return -1;
  };
  for (let id = 0; id < count; id++) {
    if (ownerNamed[id] || ownerSize[id] === 0) continue;
    const h = fnv1a(ownerKey[id]) % GRAPH_COLOR_COUNT;
    const t = ownerTarget[id];
    const b = ownerBase[id];
    const neighbours = (): void => {
      if (t >= 0 && assigned[t]) avoid[ownerColor[t]] = 1;
      if (b >= 0 && assigned[b]) avoid[ownerColor[b]] = 1;
    };
    // strict: neighbours + named colours + recent synthetic colours
    avoid.set(namedUsed);
    for (const c of recent) avoid[c] = 1;
    neighbours();
    let c = probe(h);
    if (c < 0) {
      // relaxed: neighbours + recent synthetic colours
      avoid.fill(0);
      for (const r of recent) avoid[r] = 1;
      neighbours();
      c = probe(h);
    }
    if (c < 0) {
      avoid.fill(0);
      neighbours();
      c = probe(h);
    }
    if (c < 0) c = h;
    ownerColor[id] = c;
    assigned[id] = 1;
    recent.push(c);
    if (recent.length > RECENT) recent.shift();
  }

  const nodeColor = (commit: number): number => ownerColor[owner[commit]];
  return {
    owner,
    ownerColor,
    ownerKey,
    firstParent,
    nodeColor,
    edgeColor(child: number, parent: number, dotted: boolean): number {
      if (parent < 0) return nodeColor(child);
      const fp = firstParent[child];
      if (parent === fp) return nodeColor(child);
      if (!dotted) return nodeColor(parent);
      return fp >= 0 && owner[fp] === owner[parent] ? nodeColor(child) : nodeColor(parent);
    },
  };
}
