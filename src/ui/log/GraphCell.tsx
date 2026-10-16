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

  // Transit-map casing: every line is first stroked wider in the row background, so where two lines cross the
  // later one visibly passes over the earlier one instead of the colours smearing together.
  const casing = selected ? SEL_BG : BG;
  const stroke = (e: GraphEdgeElement, path: () => void) => {
    ctx.beginPath();
    path();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = casing;
    ctx.lineWidth = lineW + CASING * 2;
    ctx.stroke();
    ctx.strokeStyle = colorOf(e.color);
    ctx.globalAlpha = e.dotted ? 0.45 : 1;
    ctx.setLineDash(e.dotted ? [lineW * 0.9, lineW * 0.9] : []);
    ctx.lineWidth = lineW;
    ctx.stroke();
  };

  for (const { up, down } of passing.values()) {
    if (up && down) {
      // Sharp metro corner at the row centre: straight in, straight out.
      const a = boundaryPoint(m, up);
      const b = boundaryPoint(m, down);
      const c = { x: laneX(m, up.lane), y: mid };
      stroke(up, () => { ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.lineTo(b.x, b.y); });
    } else {
      singles.push((up ?? down)!);
    }
  }
  // Edges touching the node (or unpaired halves at arrows): straight from the row centre; the node covers the joint.
  for (const e of singles) {
    const b = boundaryPoint(m, e);
    stroke(e, () => { ctx.moveTo(laneX(m, e.lane), mid); ctx.lineTo(b.x, b.y); });
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
  ctx.lineJoin = 'miter';
  // Chevron arrows (truncated long edges / unloaded parents), same weight as the lines.
  const a = lineW * 1.05;
  for (const ar of row.arrows) {
    const x = laneX(m, ar.lane);
    const s = ar.dir === 'down' ? 1 : -1;
    ctx.strokeStyle = colorOf(ar.color);
    ctx.beginPath();
    ctx.moveTo(x - a, mid - s * a * 0.55);
    ctx.lineTo(x, mid + s * a * 0.55);
    ctx.lineTo(x + a, mid - s * a * 0.55);
    ctx.stroke();
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
  const w = graphWidth(row.laneCount, m);
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
