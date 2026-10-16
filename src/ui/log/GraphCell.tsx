import { memo, useEffect, useRef, useSyncExternalStore } from 'react';
import type { GraphEdgeElement, GraphRow } from '../../types';
import { useMetrics, type GraphMetrics } from './density';
import { colorOf } from './palette';

export { GRAPH_PALETTE, colorOf } from './palette';

const BG = '#14161D';
const SEL_BG = '#24304F';
/** Width of the background-coloured outline drawn around each line (per side, px). */
const CASING = 1.75;

const laneX = (m: GraphMetrics, l: number): number => m.laneW * l + m.laneW / 2;

export function graphWidth(laneCount: number, m: GraphMetrics): number {
  return Math.max(1, laneCount) * m.laneW;
}

/** Whole lanes the row actually paints into: an edge heading to the next row reaches the half-lane midpoint
 *  (lane + otherLane) / 2, which can sit right of every node/edge lane in this row. Sizing the canvas only by
 *  `laneCount` clipped those diagonals at the canvas edge and left a bite in the line. */
export function rowLaneExtent(row: GraphRow): number {
  let maxPos = Math.max(row.nodeLane, row.laneCount - 1);
  for (const e of row.edges) maxPos = Math.max(maxPos, e.lane, (e.lane + e.otherLane) / 2);
  for (const a of row.arrows) maxPos = Math.max(maxPos, a.lane);
  return Math.ceil(maxPos + 1);
}

type Pt = { x: number; y: number };

/** Boundary point of a half-row edge, pushed past the canvas edge along the edge's own direction. Row r's segment
 *  and row r±1's segment are collinear (both run centre → shared midpoint → centre), so after clipping they meet
 *  exactly on the row boundary with no notch or wedge. */
function boundaryPoint(m: GraphMetrics, e: GraphEdgeElement): Pt {
  const mid = m.rowH / 2;
  const x0 = laneX(m, e.lane);
  const x1 = laneX(m, (e.lane + e.otherLane) / 2);
  const y1 = e.dir === 'down' ? m.rowH : 0;
  const len = Math.hypot(x1 - x0, y1 - mid) || 1;
  const k = (len + m.lineW) / len;
  return { x: x0 + (x1 - x0) * k, y: mid + (y1 - mid) * k };
}

/**
 * Metro rendering. A commit-to-commit connection is one straight line from row centre to row centre (each canvas
 * draws its half), so lane shifts are single clean diagonals with sharp corners and no per-row notches.
 */
export function drawGraphRow(ctx: CanvasRenderingContext2D, row: GraphRow, m: GraphMetrics, selected = false): void {
  const { rowH, lineW } = m;
  const mid = rowH / 2;
  ctx.lineWidth = lineW;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 4;

  // Pair the up/down halves of each edge passing through this row (same lane, not the node's lane).
  const passing = new Map<string, { up?: GraphEdgeElement; down?: GraphEdgeElement }>();
  const singles: GraphEdgeElement[] = [];
  for (const e of row.edges) {
    if (e.lane === row.nodeLane) { singles.push(e); continue; }
    const key = `${e.lane}|${e.color}|${e.dotted ? 1 : 0}`;
    const p = passing.get(key) ?? {};
    if (p[e.dir]) { singles.push(e); continue; }
    p[e.dir] = e;
    passing.set(key, p);
  }

  // Transit-map casing: each line is first stroked wider in the row background, so where two lines cross one
  // visibly passes over the other. Paint order is by colour index, not by row role: both halves of an edge share
  // its colour, so the same line stays on top on both sides of a row boundary (a crossing often straddles one).
  const casing = selected ? SEL_BG : BG;
  // Node edges skip casing next to the node: lines leaving the same commit must not bite into each other there.
  const nodeClear = Math.max(m.mergeR, m.nodeR + m.ring) + lineW * 0.75;
  type Item = { e: GraphEdgeElement; path: () => void; casingPath: () => void };
  const items: Item[] = [];

  for (const { up, down } of passing.values()) {
    if (up && down) {
      // Sharp metro corner at the row centre: straight in, straight out.
      const a = boundaryPoint(m, up);
      const b = boundaryPoint(m, down);
      const c = { x: laneX(m, up.lane), y: mid };
      const path = () => { ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.lineTo(b.x, b.y); };
      items.push({ e: up, path, casingPath: path });
    } else {
      singles.push((up ?? down)!);
    }
  }
  for (const e of singles) {
    const b = boundaryPoint(m, e);
    const x = laneX(m, e.lane);
    const len = Math.hypot(b.x - x, b.y - mid) || 1;
    const t = Math.min(1, nodeClear / len);
    const sx = x + (b.x - x) * t, sy = mid + (b.y - mid) * t;
    items.push({
      e,
      path: () => { ctx.moveTo(x, mid); ctx.lineTo(b.x, b.y); },
      casingPath: () => { ctx.moveTo(sx, sy); ctx.lineTo(b.x, b.y); },
    });
  }

  items.sort((p, q) => p.e.color - q.e.color);
  for (const { e, path, casingPath } of items) {
    ctx.beginPath(); casingPath();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.strokeStyle = casing; ctx.lineWidth = lineW + CASING * 2; ctx.stroke();
    ctx.beginPath(); path();
    ctx.strokeStyle = colorOf(e.color);
    ctx.globalAlpha = e.dotted ? 0.45 : 1;
    ctx.setLineDash(e.dotted ? [lineW * 0.9, lineW * 0.9] : []);
    ctx.lineWidth = lineW; ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.lineJoin = 'miter';
  // Arrows (truncated long edges / unloaded parents): a solid equilateral triangle centred on the row, its base
  // flush with the incoming line so the two read as one arrow rather than a chevron sitting on a line.
  const side = lineW * 2.4;
  const h = (side * Math.sqrt(3)) / 2;
  for (const ar of row.arrows) {
    const x = laneX(m, ar.lane);
    // Point along the line that runs into the arrow (it often arrives diagonally), not straight up/down.
    const incoming = row.edges.find((e) => e.lane === ar.lane && e.dir !== ar.dir && e.color === ar.color)
      ?? row.edges.find((e) => e.lane === ar.lane && e.dir !== ar.dir);
    let vx = 0, vy = ar.dir === 'down' ? 1 : -1;
    if (incoming) {
      const from = boundaryPoint(m, incoming);
      const len = Math.hypot(x - from.x, mid - from.y) || 1;
      vx = (x - from.x) / len; vy = (mid - from.y) / len;
    }
    const tipX = x + (vx * h) / 2, tipY = mid + (vy * h) / 2;
    const bx = x - (vx * h) / 2, by = mid - (vy * h) / 2;
    const px = -vy * (side / 2), py = vx * (side / 2);
    // Casing only on the two slanted sides: the base meets the incoming line and must not show a seam.
    ctx.beginPath();
    ctx.moveTo(bx + px, by + py);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(bx - px, by - py);
    ctx.lineJoin = 'miter';
    ctx.strokeStyle = casing;
    ctx.lineWidth = CASING * 2;
    ctx.stroke();
    ctx.closePath();
    ctx.fillStyle = colorOf(ar.color);
    ctx.fill();
  }
  const nx = laneX(m, row.nodeLane);
  const color = colorOf(row.nodeColor);
  const merge = isMergeRow(row);
  ctx.lineJoin = 'round';
  if (selected) {
    ctx.beginPath();
    ctx.arc(nx, mid, (merge ? m.mergeR : m.nodeR + m.ring / 2) + 2.5, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (merge) {
    // Interchange: white disc with a knock-out ring and a coloured core.
    ctx.beginPath();
    ctx.arc(nx, mid, m.mergeR, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = BG;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(nx, mid, m.dotR, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(nx, mid, m.nodeR, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = m.ring;
    ctx.strokeStyle = color;
    ctx.stroke();
  }
}

/** A merge commit has two or more edges leaving its node downwards (towards parents). */
function isMergeRow(row: GraphRow): boolean {
  let n = 0;
  for (const e of row.edges) if (e.dir === 'down' && e.lane === row.nodeLane) n++;
  return n > 1;
}

// One shared subscription: re-render canvases when devicePixelRatio changes (window moved between displays, zoom).
const dprListeners = new Set<() => void>();
let dprMql: MediaQueryList | null = null;
const onDprChange = () => { armDprWatch(); dprListeners.forEach((l) => l()); };
function armDprWatch(): void {
  dprMql?.removeEventListener('change', onDprChange);
  dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  dprMql.addEventListener('change', onDprChange, { once: true });
}
function subscribeDpr(l: () => void): () => void {
  if (dprListeners.size === 0 && typeof window.matchMedia === 'function') armDprWatch();
  dprListeners.add(l);
  return () => {
    dprListeners.delete(l);
    if (dprListeners.size === 0) { dprMql?.removeEventListener('change', onDprChange); dprMql = null; }
  };
}
const getDpr = (): number => window.devicePixelRatio || 1;

export const GraphCell = memo(function GraphCell({ row, selected = false }: { row: GraphRow; selected?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const m = useMetrics();
  const w = graphWidth(rowLaneExtent(row), m);
  const dpr = useSyncExternalStore(subscribeDpr, getDpr);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(m.rowH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, m.rowH);
    drawGraphRow(ctx, row, m, selected);
  }, [row, w, dpr, m, selected]);
  return <canvas ref={ref} className="graph-cell" style={{ width: w, height: m.rowH }} />;
});
