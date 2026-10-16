import { describe, expect, it } from 'vitest';
import { computeTooltipPosition, tooltipDelay } from './tooltipPosition';

const vp = { width: 800, height: 600 };
const tip = { width: 100, height: 24 };

describe('computeTooltipPosition', () => {
  it('places to the right, vertically centred', () => {
    const r = computeTooltipPosition({ left: 10, top: 100, width: 24, height: 24 }, tip, vp, 'right');
    expect(r).toEqual({ x: 40, y: 100, side: 'right' });
  });
  it('places below, horizontally centred', () => {
    const r = computeTooltipPosition({ left: 200, top: 10, width: 24, height: 24 }, tip, vp, 'bottom');
    expect(r.side).toBe('bottom');
    expect(r.x).toBe(162);
    expect(r.y).toBe(40);
  });
  it('flips when preferred side overflows', () => {
    const r = computeTooltipPosition({ left: 740, top: 100, width: 24, height: 24 }, tip, vp, 'right');
    expect(r.side).toBe('left');
    expect(r.x).toBe(740 - 100 - 6);
  });
  it('flips bottom -> top near the bottom edge', () => {
    const r = computeTooltipPosition({ left: 200, top: 580, width: 24, height: 20 }, tip, vp, 'bottom');
    expect(r.side).toBe('top');
  });
  it('clamps horizontally inside the window', () => {
    const r = computeTooltipPosition({ left: 0, top: 10, width: 10, height: 20 }, tip, vp, 'bottom');
    expect(r.x).toBe(4);
    const r2 = computeTooltipPosition({ left: 795, top: 10, width: 4, height: 20 }, tip, vp, 'bottom');
    expect(r2.x + tip.width).toBeLessThanOrEqual(vp.width - 4);
  });
  it('never returns negative coordinates for tiny viewports', () => {
    const r = computeTooltipPosition({ left: 0, top: 0, width: 10, height: 10 }, { width: 500, height: 50 }, { width: 100, height: 40 }, 'right');
    expect(r.x).toBeGreaterThanOrEqual(4);
    expect(r.y).toBeGreaterThanOrEqual(4);
  });
});

describe('tooltipDelay', () => {
  it('is instant shortly after another tooltip hid', () => {
    expect(tooltipDelay(1000, 800)).toBe(0);
    expect(tooltipDelay(1000, 100)).toBe(400);
  });
});
