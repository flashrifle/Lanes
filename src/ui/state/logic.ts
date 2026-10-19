// Pure helpers used by the store (selection, filter, visibility mask). No DOM / Tauri imports.
import type { DateRange, LogFilter, RevRange } from '../../types';

// ───────────── Selection ─────────────
export interface Selection {
  set: ReadonlySet<number>; // commit (snapshot) indices
  anchor: number | null;    // commit index
  focus: number | null;     // commit index (keyboard cursor)
}
export const EMPTY_SELECTION: Selection = { set: new Set(), anchor: null, focus: null };

export interface RowMap {
  rowCount: number;
  commitIndexAt(row: number): number;
  rowOf(commitIndex: number): number;
}

function range(map: RowMap, a: number, b: number): Set<number> {
  const s = new Set<number>();
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(map.rowCount - 1, Math.max(a, b));
  for (let r = lo; r <= hi; r++) s.add(map.commitIndexAt(r));
  return s;
}

export function selectRow(sel: Selection, row: number, mods: { shift: boolean; toggle: boolean }, map: RowMap): Selection {
  if (row < 0 || row >= map.rowCount) return sel;
  const ci = map.commitIndexAt(row);
  if (mods.shift) {
    const anchorRow = sel.anchor != null ? map.rowOf(sel.anchor) : -1;
    if (anchorRow < 0) return { set: new Set([ci]), anchor: ci, focus: ci };
    const set = mods.toggle ? new Set([...sel.set, ...range(map, anchorRow, row)]) : range(map, anchorRow, row);
    return { set, anchor: sel.anchor, focus: ci };
  }
  if (mods.toggle) {
    const set = new Set(sel.set);
    if (set.has(ci)) set.delete(ci);
    else set.add(ci);
    return { set, anchor: ci, focus: ci };
  }
  return { set: new Set([ci]), anchor: ci, focus: ci };
}

/** Move the keyboard cursor to `targetRow` (clamped); `extend` = shift-extend from anchor. */
export function moveFocusTo(sel: Selection, targetRow: number, extend: boolean, map: RowMap): Selection {
  if (map.rowCount === 0) return sel;
  const row = Math.max(0, Math.min(map.rowCount - 1, targetRow));
  return selectRow(sel, row, { shift: extend, toggle: false }, map);
}

export function currentFocusRow(sel: Selection, map: RowMap): number {
  return sel.focus != null ? map.rowOf(sel.focus) : -1;
}

export function selectAll(map: RowMap): Selection {
  if (map.rowCount === 0) return EMPTY_SELECTION;
  return { set: range(map, 0, map.rowCount - 1), anchor: map.commitIndexAt(0), focus: map.commitIndexAt(map.rowCount - 1) };
}

/** Selected commit indices ordered by visible row (newest first); hidden ones dropped. */
export function selectedInRowOrder(sel: Selection, map: RowMap): number[] {
  return [...sel.set]
    .map((ci) => ({ ci, row: map.rowOf(ci) }))
    .filter((x) => x.row >= 0)
    .sort((a, b) => a.row - b.row)
    .map((x) => x.ci);
}

export interface SelectionHashes { set: string[]; anchor: string | null; focus: string | null }

export function captureSelection(sel: Selection, hashes: string[]): SelectionHashes {
  return {
    set: [...sel.set].map((i) => hashes[i]).filter((h) => h !== undefined),
    anchor: sel.anchor != null ? hashes[sel.anchor] ?? null : null,
    focus: sel.focus != null ? hashes[sel.focus] ?? null : null,
  };
}

/** Re-map a hash-based selection onto a new snapshot (commits that vanished are dropped). */
export function restoreSelection(saved: SelectionHashes, hashToIndex: ReadonlyMap<string, number>): Selection {
  const set = new Set<number>();
  for (const h of saved.set) {
    const i = hashToIndex.get(h);
    if (i !== undefined) set.add(i);
  }
  const anchor = saved.anchor != null ? hashToIndex.get(saved.anchor) ?? null : null;
  const focus = saved.focus != null ? hashToIndex.get(saved.focus) ?? null : null;
  return { set, anchor, focus };
}

// ───────────── Filter ─────────────
export interface TextFilterUi { text: string; regex: boolean; matchCase: boolean }
export interface FilterUi {
  text: TextFilterUi;
  users: string[] | null;
  date: DateRange | null;
  paths: string[] | null;
  /** Branch compare (ui-ops): commits in `include` not in `exclude`. */
  revRange: RevRange | null;
}
export const EMPTY_FILTER_UI: FilterUi = {
  text: { text: '', regex: false, matchCase: false },
  users: null,
  date: null,
  paths: null,
  revRange: null,
};

export function toLogFilter(ui: FilterUi): LogFilter {
  const text = ui.text.text.trim() === '' ? null : { text: ui.text.text, regex: ui.text.regex, matchCase: ui.text.matchCase };
  return {
    text,
    users: ui.users && ui.users.length ? ui.users : null,
    date: ui.date && (ui.date.since != null || ui.date.until != null) ? ui.date : null,
    paths: ui.paths && ui.paths.length ? ui.paths : null,
    revRange: ui.revRange ?? null,
  };
}

export function isFilterEmpty(f: LogFilter): boolean {
  return !f.text && !f.users && !f.date && !f.paths && !f.revRange;
}

/** FilterResult.matches → GraphOptions.visible mask (null = everything visible). */
export function buildVisibleMask(commitCount: number, matches: number[] | null): Uint8Array | null {
  if (matches === null) return null;
  const mask = new Uint8Array(commitCount);
  for (const i of matches) if (i >= 0 && i < commitCount) mask[i] = 1;
  return mask;
}

export type DatePreset = 'today' | 'week' | 'month' | 'year';
export function datePresetRange(p: DatePreset, now: Date = new Date()): DateRange {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = (days: number) => Math.floor(new Date(startOfDay.getFullYear(), startOfDay.getMonth(), startOfDay.getDate() - days).getTime() / 1000);
  switch (p) {
    case 'today': return { since: back(0), until: null };
    case 'week': return { since: back(7), until: null };
    case 'month': return { since: back(30), until: null };
    case 'year': return { since: back(365), until: null };
  }
}

/** "YYYY-MM-DD" (local) → unix seconds at start / end of that day. */
export function parseDateInput(v: string, endOfDay: boolean): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = endOfDay
    ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59)
    : new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}
