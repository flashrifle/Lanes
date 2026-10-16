import { memo, useEffect, useRef } from 'react';
import type { GraphRow } from '../../types';

export const LANE_W = 14;
export const ROW_H = 22;
export const NODE_R = 3.5;
const LINE_W = 1.5;

export const GRAPH_PALETTE = [
  '#6FA8F7', '#E0AC47', '#B77FE0', '#5FB878', '#E06C75', '#4FC1C9', '#D98D5F', '#A9C25A',
  '#E070B0', '#7C8FE0', '#C8B24A', '#4DA38B', '#CC7A6B', '#8AB4C9', '#B58AD6', '#7FBF6A',
];
export const colorOf = (i: number): string => GRAPH_PALETTE[((i % 16) + 16) % 16];

const laneX = (l: number): number => LANE_W * l + LANE_W / 2;

export function graphWidth(laneCount: number): number {
  return Math.max(1, laneCount) * LANE_W;
}

export function drawGraphRow(ctx: CanvasRenderingContext2D, row: GraphRow): void {
  ctx.lineWidth = LINE_W;
  ctx.lineCap = 'round';
  const mid = ROW_H / 2;
  for (const e of row.edges) {
    ctx.beginPath();
    ctx.strokeStyle = colorOf(e.color);
    ctx.setLineDash(e.dotted ? [2, 2] : []);
    ctx.moveTo(laneX(e.lane), mid);
    ctx.lineTo(laneX((e.lane + e.otherLane) / 2), e.dir === 'down' ? ROW_H : 0);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const a of row.arrows) {
    const x = laneX(a.lane);
    const s = a.dir === 'down' ? 1 : -1;
    ctx.fillStyle = colorOf(a.color);
    ctx.beginPath();
    ctx.moveTo(x - 3.5, mid - 2 * s);
    ctx.lineTo(x + 3.5, mid - 2 * s);
    ctx.lineTo(x, mid + 3 * s);
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = colorOf(row.nodeColor);
  ctx.beginPath();
  ctx.arc(laneX(row.nodeLane), mid, NODE_R, 0, Math.PI * 2);
  ctx.fill();
}

export const GraphCell = memo(function GraphCell({ row }: { row: GraphRow }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const w = graphWidth(row.laneCount);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(ROW_H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, ROW_H);
    drawGraphRow(ctx, row);
  }, [row, w]);
  return <canvas ref={ref} className="graph-cell" style={{ width: w, height: ROW_H }} />;
});
