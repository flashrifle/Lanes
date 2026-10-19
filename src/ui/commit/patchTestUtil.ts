// Test-only helpers for patch.ts: a tiny git-like line differ producing FileDiff, and an independent
// "what should the target look like" model of a selection. Not imported by app code.
import type { DiffHunk, DiffLine, FileDiff } from '../../types';
import { lineKey, type PatchMode } from './patch';

interface Split { lines: string[]; nl: boolean }

/** "a\nb" → lines [a, b], nl false. "" → [], nl true. CR stays part of the line text. */
export function splitText(text: string): Split {
  if (text === '') return { lines: [], nl: true };
  const nl = text.endsWith('\n');
  const body = nl ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), nl };
}

export function joinText(lines: string[], nl: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (nl ? '\n' : '');
}

type Op = { kind: 'context' | 'del' | 'add'; text: string; oldLine: number | null; newLine: number | null; nonl: boolean };

/** Line diff old → new (LCS), grouped into hunks with `context` lines like `git diff -U<context>`. */
export function makeDiff(path: string, before: string, after: string, context = 3): FileDiff {
  const a = splitText(before);
  const b = splitText(after);
  // The last line without a newline differs from the same text with one (as in git).
  const keyA = a.lines.map((l, i) => (i === a.lines.length - 1 && !a.nl ? l + '\u0000' : l));
  const keyB = b.lines.map((l, i) => (i === b.lines.length - 1 && !b.nl ? l + '\u0000' : l));
  const n = keyA.length;
  const m = keyB.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = keyA[i] === keyB[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && keyA[i] === keyB[j]) {
      ops.push({ kind: 'context', text: a.lines[i], oldLine: i + 1, newLine: j + 1, nonl: i === n - 1 && !a.nl });
      i++; j++;
    } else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) {
      ops.push({ kind: 'del', text: a.lines[i], oldLine: i + 1, newLine: null, nonl: i === n - 1 && !a.nl });
      i++;
    } else {
      ops.push({ kind: 'add', text: b.lines[j], oldLine: null, newLine: j + 1, nonl: j === m - 1 && !b.nl });
      j++;
    }
  }
  // hunk ranges over ops
  const changeIdx = ops.map((o, k) => (o.kind === 'context' ? -1 : k)).filter((k) => k >= 0);
  const ranges: [number, number][] = [];
  for (const k of changeIdx) {
    const s = Math.max(0, k - context);
    const e = Math.min(ops.length, k + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else ranges.push([s, e]);
  }
  const hunks: DiffHunk[] = ranges.map(([s, e]) => {
    const seg = ops.slice(s, e);
    const lines: DiffLine[] = [];
    let oldLines = 0;
    let newLines = 0;
    for (const o of seg) {
      lines.push({ kind: o.kind, oldLine: o.oldLine, newLine: o.newLine, text: o.text });
      if (o.kind !== 'add') oldLines++;
      if (o.kind !== 'del') newLines++;
      if (o.nonl) lines.push({ kind: 'noNewline', oldLine: null, newLine: null, text: 'No newline at end of file' });
    }
    // positions: number of old/new lines strictly before the segment
    let oldBefore = 0;
    let newBefore = 0;
    for (const o of ops.slice(0, s)) { if (o.kind !== 'add') oldBefore++; if (o.kind !== 'del') newBefore++; }
    const oldStart = oldLines === 0 ? oldBefore : oldBefore + 1;
    const newStart = newLines === 0 ? newBefore : newBefore + 1;
    const header = `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`;
    return { header, oldStart, oldLines, newStart, newLines, lines };
  });
  return { path, oldPath: null, binary: false, oldMode: '100644', newMode: '100644', hunks, truncated: false };
}

/**
 * Independent model of the result: the patch target's content after applying the selection.
 * stage: start from the diff's old side, apply selected changes. unstage/discard: start from the new side,
 * revert selected changes. Needs the full old/new texts (the diff only covers hunks).
 */
export function expectedAfter(before: string, after: string, diff: FileDiff, selected: ReadonlySet<string>, mode: PatchMode): string {
  const reverse = mode !== 'stage';
  const a = splitText(before);
  const b = splitText(after);
  // result built as (text, hasNewline) per line
  const out: { text: string; nl: boolean }[] = [];
  const oldNl = (ln: number) => ln < a.lines.length || a.nl;
  const newNl = (ln: number) => ln < b.lines.length || b.nl;
  let oldPos = 1; // next old line not yet consumed
  let newPos = 1;
  const copyUnchanged = (oldUntil: number, newUntil: number) => {
    // lines outside hunks are identical on both sides
    if (reverse) { while (newPos < newUntil) { out.push({ text: b.lines[newPos - 1], nl: newNl(newPos) }); newPos++; } oldPos = oldUntil; }
    else { while (oldPos < oldUntil) { out.push({ text: a.lines[oldPos - 1], nl: oldNl(oldPos) }); oldPos++; } newPos = newUntil; }
  };
  diff.hunks.forEach((h, hi) => {
    const oldFirst = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
    const newFirst = h.newLines === 0 ? h.newStart + 1 : h.newStart;
    copyUnchanged(oldFirst, newFirst);
    h.lines.forEach((l, li) => {
      const sel = selected.has(lineKey(hi, li));
      if (l.kind === 'context') {
        out.push({ text: l.text, nl: reverse ? newNl(l.newLine!) : oldNl(l.oldLine!) });
        oldPos++; newPos++;
      } else if (l.kind === 'del') {
        const keep = reverse ? sel : !sel;
        if (keep) out.push({ text: l.text, nl: oldNl(l.oldLine!) });
        oldPos++;
      } else if (l.kind === 'add') {
        const keep = reverse ? !sel : sel;
        if (keep) out.push({ text: l.text, nl: newNl(l.newLine!) });
        newPos++;
      }
    });
  });
  copyUnchanged(a.lines.length + 1, b.lines.length + 1);
  // A line without newline that is not last cannot exist in a real file; fixtures avoid that case.
  return out.map((o, k) => o.text + (o.nl || k < out.length - 1 ? '\n' : '')).join('');
}
