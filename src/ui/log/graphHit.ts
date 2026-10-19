// Pure hit testing for the graph column. Coordinates are local to one row's graph canvas
// (x from the canvas' left edge, y from the row top). Geometry mirrors GraphCell / types.ts:
//   x(l) = laneW*l + laneW/2; node at (x(nodeLane), rowH/2);
//   'down' half: (x(lane), rowH/2) -> (x((lane+otherLane)/2), rowH); 'up' half: ... -> y = 0.
import type { GraphRow } from '../../types';
import type { GraphMetrics } from './density';

export type GraphHit =
  | { kind: 'node'; line: number }
  | { kind: 'edge'; line: number; index: number }
  | { kind: 'arrow'; line: number; index: number };

/** Extra pick radius around drawn shapes (px): thin lines are hard to hit exactly. */
export const HIT_SLOP = 3;

const laneX = (m: GraphMetrics, l: number): number => m.laneW * l + m.laneW / 2;

/** Distance from point p to segment a-b. */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Returns the graph element under (x, y), or null for empty graph space. The node wins over edges when the point
 * is inside its disc; otherwise the nearest edge/arrow within reach wins.
 */
export function hitTestGraphRow(row: GraphRow, m: GraphMetrics, x: number, y: number, slop = HIT_SLOP): GraphHit | null {
  if (!(y >= 0 && y <= m.rowH) || x < 0) return null;
  const mid = m.rowH / 2;
  const nodeR = Math.max(m.mergeR, m.nodeR + m.ring / 2);
  if (Math.hypot(x - laneX(m, row.nodeLane), y - mid) <= nodeR + slop) return { kind: 'node', line: row.nodeLine };

  let best: GraphHit | null = null;
  let bestD = Infinity;
  const reach = m.lineW / 2 + slop;
  row.edges.forEach((e, index) => {
    const ax = laneX(m, e.lane);
    const bx = laneX(m, (e.lane + e.otherLane) / 2);
    const by = e.dir === 'down' ? m.rowH : 0;
    const d = distToSegment(x, y, ax, mid, bx, by);
    if (d <= reach && d < bestD) {
      bestD = d;
      best = { kind: 'edge', line: e.line, index };
    }
  });
  const arrowReach = m.lineW * 1.2 + slop;
  row.arrows.forEach((a, index) => {
    const d = Math.hypot(x - laneX(m, a.lane), y - mid);
    if (d <= arrowReach && d < bestD) {
      bestD = d;
      best = { kind: 'arrow', line: a.line, index };
    }
  });
  return best;
}

/** Next highlight key after a click on `line`: toggles off when that line is already highlighted. */
export function nextHighlightKey(current: string | null, clickedKey: string | null): string | null {
  if (!clickedKey) return null;
  return clickedKey === current ? null : clickedKey;
}
