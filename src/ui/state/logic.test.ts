import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER_UI, EMPTY_SELECTION, buildVisibleMask, captureSelection, datePresetRange, isFilterEmpty,
  moveFocusTo, parseDateInput, restoreSelection, selectAll, selectRow, selectedInRowOrder, toLogFilter, type RowMap,
} from './logic';

// rows map to commit indices in reverse: row r -> commit (n-1-r)
const n = 6;
const map: RowMap = {
  rowCount: n,
  commitIndexAt: (r) => n - 1 - r,
  rowOf: (c) => (c >= 0 && c < n ? n - 1 - c : -1),
};
const plain = { shift: false, toggle: false };

describe('selection', () => {
  it('plain click selects one', () => {
    const s = selectRow(EMPTY_SELECTION, 1, plain, map);
    expect([...s.set]).toEqual([4]);
    expect(s.anchor).toBe(4);
  });
  it('toggle adds and removes', () => {
    let s = selectRow(EMPTY_SELECTION, 0, plain, map);
    s = selectRow(s, 2, { shift: false, toggle: true }, map);
    expect([...s.set].sort()).toEqual([3, 5]);
    s = selectRow(s, 2, { shift: false, toggle: true }, map);
    expect([...s.set]).toEqual([5]);
  });
  it('shift selects row range from anchor and keeps anchor', () => {
    let s = selectRow(EMPTY_SELECTION, 1, plain, map);
    s = selectRow(s, 3, { shift: true, toggle: false }, map);
    expect(selectedInRowOrder(s, map)).toEqual([4, 3, 2]);
    expect(s.anchor).toBe(4);
    s = selectRow(s, 0, { shift: true, toggle: false }, map);
    expect(selectedInRowOrder(s, map)).toEqual([5, 4]);
  });
  it('moveFocusTo clamps and extends', () => {
    let s = selectRow(EMPTY_SELECTION, 0, plain, map);
    s = moveFocusTo(s, -5, false, map);
    expect(s.focus).toBe(5);
    s = moveFocusTo(s, 2, true, map);
    expect(selectedInRowOrder(s, map)).toEqual([5, 4, 3]);
    s = moveFocusTo(s, 99, false, map);
    expect([...s.set]).toEqual([0]);
  });
  it('selectAll', () => {
    expect(selectAll(map).set.size).toBe(n);
  });
  it('capture/restore by hash across reloads', () => {
    const old = ['a', 'b', 'c', 'd'];
    const s = { set: new Set([1, 3]), anchor: 1, focus: 3 };
    const saved = captureSelection(s, old);
    const next = restoreSelection(saved, new Map([['x', 0], ['b', 1], ['d', 2]]));
    expect([...next.set].sort()).toEqual([1, 2]);
    expect(next.anchor).toBe(1);
    expect(next.focus).toBe(2);
    const gone = restoreSelection(saved, new Map([['x', 0]]));
    expect(gone.set.size).toBe(0);
    expect(gone.anchor).toBeNull();
  });
});

describe('filter', () => {
  it('empty ui -> empty filter', () => {
    expect(isFilterEmpty(toLogFilter(EMPTY_FILTER_UI))).toBe(true);
  });
  it('whitespace text is empty; non-empty text kept', () => {
    expect(toLogFilter({ ...EMPTY_FILTER_UI, text: { text: '  ', regex: true, matchCase: false } }).text).toBeNull();
    const f = toLogFilter({ ...EMPTY_FILTER_UI, text: { text: 'fix', regex: true, matchCase: true }, users: ['a'], paths: [] });
    expect(f.text).toEqual({ text: 'fix', regex: true, matchCase: true });
    expect(f.users).toEqual(['a']);
    expect(f.paths).toBeNull();
    expect(isFilterEmpty(f)).toBe(false);
  });
  it('visible mask', () => {
    expect(buildVisibleMask(3, null)).toBeNull();
    expect([...buildVisibleMask(4, [1, 3, 9])!]).toEqual([0, 1, 0, 1]);
  });
  it('date helpers', () => {
    const now = new Date(2026, 9, 16, 15, 0);
    const r = datePresetRange('today', now);
    expect(r.since).toBe(Math.floor(new Date(2026, 9, 16).getTime() / 1000));
    expect(datePresetRange('week', now).since).toBe(Math.floor(new Date(2026, 9, 9).getTime() / 1000));
    expect(parseDateInput('2026-10-03', false)).toBe(Math.floor(new Date(2026, 9, 3).getTime() / 1000));
    expect(parseDateInput('2026-10-03', true)! - parseDateInput('2026-10-03', false)!).toBe(86399);
    expect(parseDateInput('bad', false)).toBeNull();
  });
});
