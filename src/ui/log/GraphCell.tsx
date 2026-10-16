import { memo, useEffect, useRef, useSyncExternalStore } from 'react';
import type { GraphRow } from '../../types';
import { useMetrics, type GraphMetrics } from './density';
import { colorOf } from './palette';

export { GRAPH_PALETTE, colorOf } from './palette';

const BG = '#14161D';

const laneX = (m: GraphMetrics, l: number): number => m.laneW * l + m.laneW / 2;

export function graphWidth(laneCount: number, m: GraphMetrics): number {
  return Math.max(1, laneCount) * m.laneW;
}

/**
 * Metro rendering. Each half-row edge is a straight diagonal (45 degrees whenever the half-row is tall enough
 * for the lane shift, otherwise as steep as the geometry allows) followed by a vertical run to the row boundary.
 * The boundary end is extended past the canvas and clipped, so adjacent rows join without butt-cap gaps.
 */
export function drawGraphRow(ctx: CanvasRenderingContext2D, row: GraphRow, m: GraphMetrics, selected = false): void {
  const { rowH, lineW } = m;
  const mid = rowH / 2;
  ctx.lineWidth = lineW;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.miterLimit = 6;
  for (const e of row.edges) {
    const x0 = laneX(m, e.lane);
    const x1 = laneX(m, (e.lane + e.otherLane) / 2);
    const s = e.dir === 'down' ? 1 : -1;
    const yEnd = e.dir === 'down' ? rowH : 0;
    const dx = Math.abs(x1 - x0);
    const half = mid;
    ctx.beginPath();
    ctx.strokeStyle = colorOf(e.color);
    ctx.globalAlpha = e.dotted ? 0.45 : 1;
    ctx.setLineDash(e.dotted ? [lineW * 0.9, lineW * 0.9] : []);
    ctx.moveTo(x0, mid);
    if (dx < 0.01) {
      ctx.lineTo(x0, yEnd + s * lineW);
    } else if (dx >= half) {
      // Too shallow for a 45 degree run: one straight diagonal to the boundary (extended along its direction).
      const k = lineW / half;
      ctx.lineTo(x1 + (x1 - x0) * k, yEnd + s * lineW);
    } else {
      ctx.lineTo(x1, mid + s * dx);
      ctx.lineTo(x1, yEnd + s * lineW);
    }
    ctx.stroke();
    if (!e.dotted && dx > 0.01) {
      // Round join at the row centre so the up/down halves of a lane shift meet without a wedge-shaped gap.
      ctx.beginPath();
      ctx.arc(x0, mid, lineW / 2, 0, Math.PI * 2);
      ctx.fillStyle = colorOf(e.color);
      ctx.fill();
    }
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
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
