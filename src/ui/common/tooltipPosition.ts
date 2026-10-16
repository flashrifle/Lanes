// Pure positioning math for tooltips.
export type TipSide = 'top' | 'bottom' | 'left' | 'right';
export interface Rect { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }

const OPPOSITE: Record<TipSide, TipSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

function place(anchor: Rect, tip: Size, side: TipSide, gap: number): { x: number; y: number } {
  switch (side) {
    case 'right': return { x: anchor.left + anchor.width + gap, y: anchor.top + (anchor.height - tip.height) / 2 };
    case 'left': return { x: anchor.left - tip.width - gap, y: anchor.top + (anchor.height - tip.height) / 2 };
    case 'bottom': return { x: anchor.left + (anchor.width - tip.width) / 2, y: anchor.top + anchor.height + gap };
    case 'top': return { x: anchor.left + (anchor.width - tip.width) / 2, y: anchor.top - tip.height - gap };
  }
}

function fits(p: { x: number; y: number }, tip: Size, vp: Size, margin: number): boolean {
  return p.x >= margin && p.y >= margin && p.x + tip.width <= vp.width - margin && p.y + tip.height <= vp.height - margin;
}

/** Prefer `side`; flip to the opposite side if it doesn't fit; finally clamp into the viewport. */
export function computeTooltipPosition(
  anchor: Rect, tip: Size, viewport: Size, preferred: TipSide, gap = 6, margin = 4,
): { x: number; y: number; side: TipSide } {
  let side = preferred;
  let p = place(anchor, tip, side, gap);
  if (!fits(p, tip, viewport, margin)) {
    const alt = place(anchor, tip, OPPOSITE[preferred], gap);
    if (fits(alt, tip, viewport, margin)) { side = OPPOSITE[preferred]; p = alt; }
  }
  const maxX = Math.max(margin, viewport.width - tip.width - margin);
  const maxY = Math.max(margin, viewport.height - tip.height - margin);
  return { x: Math.min(Math.max(margin, p.x), maxX), y: Math.min(Math.max(margin, p.y), maxY), side };
}

/** Delay before showing: instant when a tooltip was visible/hidden very recently (moving between neighbours). */
export function tooltipDelay(now: number, lastHiddenAt: number, base = 400, graceMs = 300): number {
  return now - lastHiddenAt <= graceMs ? 0 : base;
}
