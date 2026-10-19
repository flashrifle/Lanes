// Pure helpers for "Show History for Selection": line-range selection state and DOM extraction.
import type { LineRange } from '../types';

/** Anchor + focus line of a selection (focus may be above the anchor). */
export interface LineSel {
  anchor: number;
  focus: number;
}

export const rangeOf = (s: LineSel): LineRange => ({ start: Math.min(s.anchor, s.focus), end: Math.max(s.anchor, s.focus) });

/** Plain click selects one line; shift+click extends from the anchor. */
export function clickLine(prev: LineSel | null, line: number, shift: boolean): LineSel {
  return shift && prev ? { anchor: prev.anchor, focus: line } : { anchor: line, focus: line };
}

export const inRange = (r: LineRange, line: number): boolean => line >= r.start && line <= r.end;

/** Range of a set of line numbers (ignores non-positive / NaN). */
export function rangeOfNumbers(nums: number[]): LineRange | null {
  const ok = nums.filter((n) => Number.isInteger(n) && n > 0);
  return ok.length === 0 ? null : { start: Math.min(...ok), end: Math.max(...ok) };
}

function elementOf(n: Node | null): Element | null {
  return !n ? null : n.nodeType === 1 ? (n as Element) : n.parentElement;
}

/** Line number from the closest ancestor carrying `data-line`. */
export function lineOfNode(n: Node | null): number | null {
  const el = elementOf(n)?.closest('[data-line]');
  const v = el ? Number(el.getAttribute('data-line')) : NaN;
  return Number.isInteger(v) && v > 0 ? v : null;
}

/** Lines covered by the current native text selection inside `root` (rows carry `data-line`), or null. */
export function rangeFromDomSelection(root: Element, sel: Selection | null = typeof window !== 'undefined' ? window.getSelection() : null): LineRange | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
  const a = lineOfNode(sel.anchorNode);
  const b = lineOfNode(sel.focusNode);
  return rangeOfNumbers([a ?? NaN, b ?? NaN]);
}

/** Range for the new-side line numbers of the diff rows (`.dw-row`) a native selection touches. */
export function diffRangeFromSelection(root: Element, sel: Selection | null = typeof window !== 'undefined' ? window.getSelection() : null): LineRange | null {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
  const r = sel.getRangeAt(0);
  const nums: number[] = [];
  root.querySelectorAll('.dw-row').forEach((row) => {
    if (r.intersectsNode(row)) nums.push(Number(row.querySelector('.dw-ln-r')?.textContent?.trim()));
  });
  return rangeOfNumbers(nums);
}

/** New-side line number of the diff row under `target` (right-click without a selection). */
export function diffLineOfTarget(target: EventTarget | null): LineRange | null {
  const row = elementOf(target as Node | null)?.closest('.dw-row');
  const n = Number(row?.querySelector('.dw-ln-r')?.textContent?.trim());
  return Number.isInteger(n) && n > 0 ? { start: n, end: n } : null;
}
