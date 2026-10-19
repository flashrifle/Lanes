import { describe, expect, it } from 'vitest';
import type { GraphLayout } from '../../types';
import { build, randomSnapshot, ref, rowsOf, snapshot, SORTS } from './helpers';

/** every element's colour must be its line's colour (line implies colour) */
function lineColorTable(l: GraphLayout): string | null {
  const color = new Map<number, number>();
  const check = (line: number, c: number, what: string): string | null => {
    if (line < 0) return `${what}: negative line`;
    const prev = color.get(line);
    if (prev === undefined) color.set(line, c);
    else if (prev !== c) return `${what}: line ${line} has colours ${prev} and ${c}`;
    return null;
  };
  for (let r = 0; r < l.rowCount; r++) {
    const row = l.getRow(r);
    if (row.nodeLine !== l.lineOf(row.commitIndex)) return `row ${r}: nodeLine != lineOf`;
    const bad =
      check(row.nodeLine, row.nodeColor, `row ${r} node`) ??
      row.edges.map((e) => check(e.line, e.color, `row ${r} edge`)).find(Boolean) ??
      row.arrows.map((a) => check(a.line, a.color, `row ${r} arrow`)).find(Boolean);
    if (bad) return bad;
  }
  return null;
}

/** up/down pairing including line: every 'down' in row r has a matching 'up' in row r+1 with the same line */
function checkLinePairing(l: GraphLayout): string | null {
  const key = (lane: number, other: number, color: number, dotted: boolean, line: number) => `${lane}|${other}|${color}|${dotted ? 1 : 0}|${line}`;
  let prev: Map<string, number> | null = null;
  for (let r = 0; r < l.rowCount; r++) {
    const row = l.getRow(r);
    const ups = new Map<string, number>();
    const downs = new Map<string, number>();
    for (const e of row.edges) {
      if (e.dir === 'up') {
        const k = key(e.otherLane, e.lane, e.color, e.dotted, e.line);
        ups.set(k, (ups.get(k) ?? 0) + 1);
      } else {
        const k = key(e.lane, e.otherLane, e.color, e.dotted, e.line);
        downs.set(k, (downs.get(k) ?? 0) + 1);
      }
    }
    if (prev) for (const [k, c] of prev) if (ups.get(k) !== c) return `row ${r}: down ${k} unmatched`;
    prev = r === l.rowCount - 1 ? null : downs;
  }
  return null;
}

describe('line ids', () => {
  // 0 feat tip, 1 main merge(2, 0's chain), 2 main, 3 feat base?, simple fork:
  //   0 (feat) -> 3, 1 (main, merge of 2 and 4) , 2 -> 5, 3 -> 5, 4 -> 5, 5 root
  const parents = [[3], [2, 4], [5], [5], [5], []];
  const refs = [ref('main', 1, { isCurrent: true }), ref('feat', 0), ref('origin/main', 1, { type: 'remoteBranch', remote: 'origin' }), ref('v1', 5, { type: 'tag' })];
  const l = build(snapshot(parents, { refs }));

  it('nodeLine / lineKey match ownership', () => {
    expect(l.lineKey(l.lineOf(1))).toBe('b:main');
    expect(l.lineKey(l.lineOf(2))).toBe('b:main');
    expect(l.lineKey(l.lineOf(5))).toBe('b:main');
    expect(l.lineKey(l.lineOf(0))).toBe('b:feat');
    expect(l.lineKey(l.lineOf(3))).toBe('b:feat');
    expect(l.lineKey(l.lineOf(4))).toBe('merge:h1');
    expect(l.lineOf(99)).toBe(-1);
    expect(l.lineKey(-1)).toBe('');
    expect(l.lineKey(9999)).toBe('');
  });

  it('lineOfKey inverts lineKey', () => {
    for (let c = 0; c < parents.length; c++) expect(l.lineOfKey(l.lineKey(l.lineOf(c)))).toBe(l.lineOf(c));
    expect(l.lineOfKey('b:nope')).toBe(-1);
    expect(l.lineOfKey('')).toBe(-1);
  });

  it('merge edge carries the merged parent line, first-parent edge the child line', () => {
    const row = l.getRow(l.rowOf(1));
    const downs = row.edges.filter((e) => e.dir === 'down' && e.lane === row.nodeLane);
    const lines = new Set(downs.map((e) => e.line));
    expect(lines).toEqual(new Set([l.lineOf(1), l.lineOf(4)]));
  });

  it('lineOfRef: own line, remote shares local line, fallback to commit owner, -1 if unknown', () => {
    expect(l.lineOfRef('refs/heads/main')).toBe(l.lineOfKey('b:main'));
    expect(l.lineOfRef('refs/remotes/origin/main')).toBe(l.lineOfKey('b:main'));
    expect(l.lineOfRef('refs/heads/feat')).toBe(l.lineOfKey('b:feat'));
    // tag v1 sits on main's root: it owns nothing, so it maps to main's line
    expect(l.lineOfKey('tag:v1')).toBe(-1);
    expect(l.lineOfRef('refs/tags/v1')).toBe(l.lineOf(5));
    expect(l.lineOfRef('refs/heads/missing')).toBe(-1);
  });

  it('lineOfRef: not-loaded ref -> -1', () => {
    const l2 = build(snapshot(parents, { refs: [...refs, ref('gone', 0, { index: null })] }));
    expect(l2.lineOfRef('refs/heads/gone')).toBe(-1);
  });

  it('lineKey stable across a reload with new commits', () => {
    // reload: two new commits on top of main (new merge 0 of feat-ish side + main), indices shift by 2
    const shifted = parents.map((ps) => ps.map((p) => p + 2));
    const p2 = [[1], [3], ...shifted];
    const s2 = snapshot(p2, { refs: [ref('main', 0, { isCurrent: true }), ref('feat', 2), ref('v1', 7, { type: 'tag' })] });
    s2.hashes = ['n0', 'n1', 'h0', 'h1', 'h2', 'h3', 'h4', 'h5'];
    const l2 = build(s2);
    for (let c = 0; c < parents.length; c++) expect(l2.lineKey(l2.lineOf(c + 2))).toBe(l.lineKey(l.lineOf(c)));
    expect(l2.lineKey(l2.lineOf(0))).toBe('b:main');
  });

  for (const sortType of SORTS) {
    for (const filtered of [false, true]) {
      it(`random graphs: line implies colour, halves share line (${sortType}${filtered ? ', filtered' : ''})`, () => {
        for (const seed of [1, 2, 3]) {
          const snap = randomSnapshot(1500, seed);
          let visible: Uint8Array | null = null;
          if (filtered) {
            visible = new Uint8Array(snap.commitCount);
            for (let i = 0; i < visible.length; i += 2) visible[i] = 1;
          }
          const lay = build(snap, { sortType, visible });
          expect(lineColorTable(lay)).toBeNull();
          expect(checkLinePairing(lay)).toBeNull();
          for (const row of rowsOf(lay)) expect(lay.lineOfKey(lay.lineKey(row.nodeLine))).toBe(row.nodeLine);
        }
      });
    }
  }
});
