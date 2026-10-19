import { describe, expect, it } from 'vitest';
import type { GraphRow } from '../../types';
import { DENSITIES } from './density';
import { distToSegment, hitTestGraphRow, nextHighlightKey } from './graphHit';

const m = DENSITIES.comfortable; // rowH 36, laneW 28, lineW 6.5
const x = (l: number) => m.laneW * l + m.laneW / 2;
const mid = m.rowH / 2;

// node in lane 0 (line 1); its down edge to lane 0 (line 1); a passing edge in lane 1 (line 2) going
// up straight and down to lane 2 (diagonal); an arrow in lane 3 (line 3).
const row: GraphRow = {
  commitIndex: 0,
  nodeLane: 0,
  nodeColor: 0,
  nodeLine: 1,
  laneCount: 4,
  edges: [
    { dir: 'down', lane: 0, otherLane: 0, color: 0, dotted: false, line: 1 },
    { dir: 'up', lane: 1, otherLane: 1, color: 2, dotted: false, line: 2 },
    { dir: 'down', lane: 1, otherLane: 2, color: 2, dotted: false, line: 2 },
  ],
  arrows: [{ dir: 'down', lane: 3, color: 3, line: 3 }],
};

describe('graphHit', () => {
  it('distToSegment', () => {
    expect(distToSegment(0, 5, 0, 0, 0, 10)).toBe(0);
    expect(distToSegment(3, 5, 0, 0, 0, 10)).toBe(3);
    expect(distToSegment(0, 14, 0, 0, 0, 10)).toBe(4);
    expect(distToSegment(3, 4, 0, 0, 0, 0)).toBe(5);
  });

  it('node centre and rim hit the node line', () => {
    expect(hitTestGraphRow(row, m, x(0), mid)).toEqual({ kind: 'node', line: 1 });
    expect(hitTestGraphRow(row, m, x(0) + m.mergeR, mid)).toEqual({ kind: 'node', line: 1 });
  });

  it('edge below the node hits the first-parent edge', () => {
    expect(hitTestGraphRow(row, m, x(0) + 1, m.rowH - 2)).toMatchObject({ kind: 'edge', line: 1, index: 0 });
  });

  it('passing straight edge above centre', () => {
    expect(hitTestGraphRow(row, m, x(1) + 2, 3)).toMatchObject({ kind: 'edge', line: 2, index: 1 });
  });

  it('diagonal half: point on the segment midway to x(1.5) at the bottom', () => {
    const px = (x(1) + x(1.5)) / 2;
    const py = (mid + m.rowH) / 2;
    expect(hitTestGraphRow(row, m, px, py)).toMatchObject({ kind: 'edge', line: 2, index: 2 });
  });

  it('arrow', () => {
    expect(hitTestGraphRow(row, m, x(3), mid + 2)).toMatchObject({ kind: 'arrow', line: 3 });
  });

  it('empty space and out-of-row points miss', () => {
    expect(hitTestGraphRow(row, m, x(2), 4)).toBeNull(); // between lanes, top half
    expect(hitTestGraphRow(row, m, x(0) + m.laneW / 2, 2)).toBeNull();
    expect(hitTestGraphRow(row, m, x(0), -1)).toBeNull();
    expect(hitTestGraphRow(row, m, x(0), m.rowH + 1)).toBeNull();
    expect(hitTestGraphRow(row, m, -1, mid)).toBeNull();
  });

  it('works in compact density', () => {
    const c = DENSITIES.compact;
    const cx = c.laneW / 2;
    expect(hitTestGraphRow(row, c, cx, c.rowH / 2)).toEqual({ kind: 'node', line: 1 });
  });

  it('nextHighlightKey toggles and clears', () => {
    expect(nextHighlightKey(null, 'b:main')).toBe('b:main');
    expect(nextHighlightKey('b:main', 'b:feat')).toBe('b:feat');
    expect(nextHighlightKey('b:main', 'b:main')).toBeNull();
    expect(nextHighlightKey('b:main', null)).toBeNull();
  });
});
