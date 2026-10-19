// Builds side-by-side (and unified) row models from a FileDiff. Pure; no DOM.
import type { FileDiff } from '../types';
import { diffWords, type Range } from './intraline';

export type BlockType = 'insert' | 'delete' | 'modify';

export interface SideLine {
  line: number;          // 1-based line number on this side
  text: string;
  noNewline: boolean;    // "\ No newline at end of file" applies to this line
  /** Word-level highlight ranges. [] = none; null = word diff unavailable (whole line counts as changed). */
  hl: Range[] | null;
  /** Add / del lines: selection key "h:l" (FileDiff hunk index : line index) for line staging; null for context. */
  key: string | null;
}

export type SbsRow =
  | { kind: 'equal'; left: SideLine; right: SideLine; block: -1 }
  | { kind: 'change'; left: SideLine | null; right: SideLine | null; block: number }
  | { kind: 'gap'; count: number; left: null; right: null; block: -1 };

export type UniRow =
  | { kind: 'equal'; oldLine: number; newLine: number; line: SideLine; block: -1 }
  | { kind: 'del'; oldLine: number; newLine: null; line: SideLine; block: number }
  | { kind: 'add'; oldLine: null; newLine: number; line: SideLine; block: number }
  | { kind: 'gap'; count: number; block: -1 };

export interface ChangeBlock {
  index: number;
  type: BlockType;
  sbsStart: number; // [start, end) in DiffModel.sbs
  sbsEnd: number;
  uniStart: number; // [start, end) in DiffModel.uni
  uniEnd: number;
  delCount: number;
  addCount: number;
}

export interface DiffModel {
  sbs: SbsRow[];
  uni: UniRow[];
  blocks: ChangeBlock[];
  /** Max display width (columns; wide chars = 2, tab = 4) per side, for horizontal scroll extents. */
  leftCols: number;
  rightCols: number;
}

/** Display width in monospace columns (East Asian wide = 2, tab = 4). */
export function displayCols(s: string): number {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x1100) { w += c === 9 ? 4 : 1; continue; }
    if (c >= 0xd800 && c <= 0xdbff) { w += 2; i++; continue; } // astral: mostly CJK ext / emoji
    if (
      (c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6)
    ) w += 2;
    else w += 1;
  }
  return w;
}

const mk = (line: number, text: string, key: string | null = null): SideLine => ({ line, text, noNewline: false, hl: [], key });

/** Split ranges over a '\n'-joined text into per-line ranges (offsets relative to each line). */
function splitRanges(lines: string[], ranges: Range[]): Range[][] {
  const out: Range[][] = lines.map(() => []);
  const starts: number[] = [];
  let o = 0;
  for (const l of lines) { starts.push(o); o += l.length + 1; }
  let li = 0;
  for (const [s, e] of ranges) {
    while (li < lines.length - 1 && starts[li + 1] <= s) li++;
    for (let k = li; k < lines.length && starts[k] < e; k++) {
      const ls = starts[k];
      const cs = Math.max(s, ls);
      const ce = Math.min(e, ls + lines[k].length);
      if (ce > cs) out[k].push([cs - ls, ce - ls]);
    }
  }
  return out;
}

/** Max line pairs evaluated when pairing lines inside a modified block. */
const MAX_PAIR_CELLS = 2500;
/** Upper bound on chars fed to pairwise word diffs for one block. */
const MAX_PAIR_WORK = 400_000;

const sumLen = (rs: Range[]) => rs.reduce((n, [s, e]) => n + e - s, 0);

/**
 * Pairs similar lines of a modified block (weighted LCS on per-line word diffs), fills SideLine.hl,
 * and returns the block's side-by-side rows: paired lines share a row, unpaired runs are zipped with
 * filler (null) on the shorter side. Large blocks fall back to one word diff over the whole block.
 */
function alignBlock(dels: SideLine[], adds: SideLine[]): [SideLine | null, SideLine | null][] {
  const L = dels.length;
  const R = adds.length;
  const zip = (ls: SideLine[], rs: SideLine[], out: [SideLine | null, SideLine | null][]) => {
    for (let i = 0; i < Math.max(ls.length, rs.length); i++) out.push([ls[i] ?? null, rs[i] ?? null]);
  };

  const lChars = dels.reduce((n, l) => n + l.text.length, 0);
  const rChars = adds.reduce((n, l) => n + l.text.length, 0);
  if (L * R > MAX_PAIR_CELLS || lChars * R + rChars * L > MAX_PAIR_WORK) {
    const lt = dels.map((l) => l.text);
    const rt = adds.map((l) => l.text);
    const wd = diffWords(lt.join('\n'), rt.join('\n'));
    const lh = wd ? splitRanges(lt, wd.left) : null;
    const rh = wd ? splitRanges(rt, wd.right) : null;
    dels.forEach((l, i) => (l.hl = lh ? lh[i] : null));
    adds.forEach((l, i) => (l.hl = rh ? rh[i] : null));
    const out: [SideLine | null, SideLine | null][] = [];
    zip(dels, adds, out);
    return out;
  }

  // per-pair word diff + weight (= unchanged chars on both sides)
  const pair: (ReturnType<typeof diffWords>)[] = new Array(L * R);
  const weight = new Float64Array(L * R);
  for (let i = 0; i < L; i++) {
    for (let j = 0; j < R; j++) {
      const a = dels[i].text;
      const b = adds[j].text;
      const wd = diffWords(a, b);
      pair[i * R + j] = wd;
      if (!wd) continue;
      const w = a.length - sumLen(wd.left) + b.length - sumLen(wd.right);
      weight[i * R + j] = a.length + b.length === 0 ? 1 : w;
    }
  }
  // DP: S[i][j] best score for dels[i..] / adds[j..]
  const S = new Float64Array((L + 1) * (R + 1));
  const W = R + 1;
  for (let i = L - 1; i >= 0; i--) {
    for (let j = R - 1; j >= 0; j--) {
      let best = Math.max(S[(i + 1) * W + j], S[i * W + j + 1]);
      const w = weight[i * R + j];
      if (w > 0) best = Math.max(best, S[(i + 1) * W + j + 1] + w);
      S[i * W + j] = best;
    }
  }
  const out: [SideLine | null, SideLine | null][] = [];
  let i = 0;
  let j = 0;
  let pendL: SideLine[] = [];
  let pendR: SideLine[] = [];
  let paired = false;
  const whole = (l: SideLine) => { l.hl = l.text.length ? [[0, l.text.length]] : []; };
  while (i < L || j < R) {
    if (i < L && j < R) {
      const w = weight[i * R + j];
      if (w > 0 && S[i * W + j] === S[(i + 1) * W + j + 1] + w) {
        zip(pendL, pendR, out);
        pendL = [];
        pendR = [];
        const wd = pair[i * R + j]!;
        dels[i].hl = wd.left;
        adds[j].hl = wd.right;
        out.push([dels[i], adds[j]]);
        paired = true;
        i++;
        j++;
        continue;
      }
      if (S[i * W + j] === S[(i + 1) * W + j]) { whole(dels[i]); pendL.push(dels[i++]); }
      else { whole(adds[j]); pendR.push(adds[j++]); }
    } else if (i < L) { whole(dels[i]); pendL.push(dels[i++]); }
    else { whole(adds[j]); pendR.push(adds[j++]); }
  }
  zip(pendL, pendR, out);
  if (!paired) {
    // nothing similar enough to pair: plain block tint, no word highlights
    for (const l of dels) l.hl = null;
    for (const r of adds) r.hl = null;
  }
  return out;
}

export function buildDiffModel(diff: FileDiff): DiffModel {
  const sbs: SbsRow[] = [];
  const uni: UniRow[] = [];
  const blocks: ChangeBlock[] = [];
  let leftCols = 0;
  let rightCols = 0;

  let dels: SideLine[] = [];
  let adds: SideLine[] = [];
  // last line touched, for attaching "\ No newline"
  let lastTouched: SideLine[] = [];

  const flush = () => {
    if (dels.length === 0 && adds.length === 0) return;
    const type: BlockType = dels.length === 0 ? 'insert' : adds.length === 0 ? 'delete' : 'modify';
    const index = blocks.length;
    const sbsStart = sbs.length;
    const uniStart = uni.length;
    if (type === 'modify') {
      for (const [l, r] of alignBlock(dels, adds)) sbs.push({ kind: 'change', left: l, right: r, block: index });
    } else {
      const n = Math.max(dels.length, adds.length);
      for (let i = 0; i < n; i++) sbs.push({ kind: 'change', left: dels[i] ?? null, right: adds[i] ?? null, block: index });
    }
    for (const l of dels) uni.push({ kind: 'del', oldLine: l.line, newLine: null, line: l, block: index });
    for (const l of adds) uni.push({ kind: 'add', oldLine: null, newLine: l.line, line: l, block: index });
    blocks.push({
      index, type, sbsStart, sbsEnd: sbs.length, uniStart, uniEnd: uni.length,
      delCount: dels.length, addCount: adds.length,
    });
    dels = [];
    adds = [];
  };

  let expectOld = 1;
  diff.hunks.forEach((h, hi) => {
    const firstOld = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
    const gap = firstOld - expectOld;
    if (gap > 0) {
      flush();
      sbs.push({ kind: 'gap', count: gap, left: null, right: null, block: -1 });
      uni.push({ kind: 'gap', count: gap, block: -1 });
    }
    expectOld = firstOld + h.oldLines;

    h.lines.forEach((dl, li) => {
      switch (dl.kind) {
        case 'context': {
          flush();
          const l = mk(dl.oldLine ?? 0, dl.text);
          const r = mk(dl.newLine ?? 0, dl.text);
          sbs.push({ kind: 'equal', left: l, right: r, block: -1 });
          uni.push({ kind: 'equal', oldLine: l.line, newLine: r.line, line: l, block: -1 });
          leftCols = Math.max(leftCols, displayCols(dl.text));
          rightCols = Math.max(rightCols, displayCols(dl.text));
          lastTouched = [l, r];
          break;
        }
        case 'del': {
          const l = mk(dl.oldLine ?? 0, dl.text, `${hi}:${li}`);
          // a del after adds starts a new block only if git emitted add-then-del (rare); keep grouping.
          dels.push(l);
          leftCols = Math.max(leftCols, displayCols(dl.text));
          lastTouched = [l];
          break;
        }
        case 'add': {
          const r = mk(dl.newLine ?? 0, dl.text, `${hi}:${li}`);
          adds.push(r);
          rightCols = Math.max(rightCols, displayCols(dl.text));
          lastTouched = [r];
          break;
        }
        case 'noNewline':
          for (const t of lastTouched) t.noNewline = true;
          break;
      }
    });
    flush();
  });
  flush();
  return { sbs, uni, blocks, leftCols, rightCols };
}

// ───────────── Collapsing unchanged runs ─────────────

export type DisplayItem =
  | { kind: 'row'; index: number }
  | { kind: 'fold'; start: number; end: number }; // hidden rows [start, end)

export interface DisplayList {
  items: DisplayItem[];
  /** row index → display item index (a folded row maps to its fold item). */
  rowToItem: Int32Array;
}

export interface CollapseOptions {
  collapse: boolean;
  expanded: ReadonlySet<number>; // fold start indices the user expanded
  context?: number;              // lines kept around changes (default 3)
  minRun?: number;               // only runs longer than this fold (default 8)
}

/**
 * kinds[i]: 'equal' | 'change' | 'gap'. Unchanged runs longer than minRun are folded, keeping
 * `context` lines next to changes. Files without any change are never folded.
 */
export function buildDisplay(kinds: ArrayLike<'equal' | 'change' | 'gap'>, opts: CollapseOptions): DisplayList {
  const n = kinds.length;
  const items: DisplayItem[] = [];
  const rowToItem = new Int32Array(n);
  const ctx = opts.context ?? 3;
  const minRun = opts.minRun ?? 8;
  let anyChange = false;
  for (let i = 0; i < n; i++) if (kinds[i] === 'change') { anyChange = true; break; }
  const fold = opts.collapse && anyChange;

  let i = 0;
  while (i < n) {
    if (!fold || kinds[i] !== 'equal') {
      rowToItem[i] = items.length;
      items.push({ kind: 'row', index: i });
      i++;
      continue;
    }
    let j = i;
    while (j < n && kinds[j] === 'equal') j++;
    const len = j - i;
    const keepTop = i > 0 && kinds[i - 1] === 'change' ? ctx : 0;
    const keepBottom = j < n && kinds[j] === 'change' ? ctx : 0;
    const fs = i + keepTop;
    const fe = j - keepBottom;
    if (len > minRun && fe > fs && !opts.expanded.has(fs)) {
      for (let k = i; k < fs; k++) { rowToItem[k] = items.length; items.push({ kind: 'row', index: k }); }
      const foldIdx = items.length;
      items.push({ kind: 'fold', start: fs, end: fe });
      for (let k = fs; k < fe; k++) rowToItem[k] = foldIdx;
      for (let k = fe; k < j; k++) { rowToItem[k] = items.length; items.push({ kind: 'row', index: k }); }
    } else {
      for (let k = i; k < j; k++) { rowToItem[k] = items.length; items.push({ kind: 'row', index: k }); }
    }
    i = j;
  }
  return { items, rowToItem };
}

export const sbsKinds = (m: DiffModel) => m.sbs.map((r) => r.kind);
export const uniKinds = (m: DiffModel) =>
  m.uni.map((r) => (r.kind === 'equal' ? 'equal' : r.kind === 'gap' ? 'gap' : 'change')) as ('equal' | 'change' | 'gap')[];
