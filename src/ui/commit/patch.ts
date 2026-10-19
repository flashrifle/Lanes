// Line / hunk staging patch builder (docs/PLAN-v0.1.md §1.1). Pure: no DOM, no IPC.
//
// buildPatch(diff, selected, mode) turns a FileDiff plus a set of selected change lines ("h:l" = hunk index :
// line index into diff.hunks[h].lines) into a single-file unified diff for `apply_patch`:
//  - stage   (unstaged diff, target index,    forward):  unselected add → dropped, unselected del → context
//  - unstage (staged diff,   target index,    --reverse): unselected add → context, unselected del → dropped
//  - discard (unstaged diff, target worktree, --reverse): same as unstage
// Reverse patches are written in the diff's own direction; the backend applies them with --reverse.
import type { ApplyPatchRequest, DiffLine, FileDiff, FileStatus } from '../../types';

export type PatchMode = 'stage' | 'unstage' | 'discard';

const NO_NEWLINE = '\\ No newline at end of file';

/** Selection key of one diff line. */
export const lineKey = (hunk: number, line: number): string => `${hunk}:${line}`;

const isChange = (l: DiffLine): boolean => l.kind === 'add' || l.kind === 'del';

/** Every selectable (add/del) line key of the diff, in order. */
export function changeKeys(diff: FileDiff): string[] {
  const out: string[] = [];
  diff.hunks.forEach((h, hi) => h.lines.forEach((l, li) => { if (isChange(l)) out.push(lineKey(hi, li)); }));
  return out;
}

/** Keys of the add/del lines of one hunk. */
export function hunkKeys(diff: FileDiff, hunk: number): string[] {
  const h = diff.hunks[hunk];
  if (!h) return [];
  const out: string[] = [];
  h.lines.forEach((l, li) => { if (isChange(l)) out.push(lineKey(hunk, li)); });
  return out;
}

// eslint-disable-next-line no-control-regex
const NEEDS_QUOTE = /["\\\x00-\x1f\x7f]|^ | $/;
const ESC: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\x07': '\\a', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\v': '\\v', '\f': '\\f', '\r': '\\r' };

/**
 * A header path token ("a/<path>" / "b/<path>"), C-quoted like git when the path contains `"`, `\`, a control
 * character, or a leading / trailing space. Other characters (including non-ASCII) are kept verbatim.
 */
export function headerPath(prefix: 'a/' | 'b/', path: string): string {
  if (!NEEDS_QUOTE.test(path)) return prefix + path;
  let s = '"' + prefix;
  for (const ch of path) {
    const c = ch.charCodeAt(0);
    if (ESC[ch] !== undefined) s += ESC[ch];
    else if (c < 0x20 || c === 0x7f) s += '\\' + c.toString(8).padStart(3, '0');
    else s += ch;
  }
  return s + '"';
}

/**
 * Build the patch, or null when no add/del line is selected.
 * Hunks without a selected change are omitted and counts are recomputed. With delta = cumulative
 * (newCount - oldCount) of the emitted hunks before this one:
 *  - stage:   oldStart is kept, newStart = oldStart + delta
 *  - reverse: first = newStart(diff) - delta, and both sides start at `first`
 * (with the unified-diff convention that a side with 0 lines names the line before the hunk).
 */
export function buildPatch(diff: FileDiff, selected: ReadonlySet<string>, mode: PatchMode): string | null {
  const reverse = mode !== 'stage';
  const path = diff.path;
  const body: string[] = [];
  let delta = 0;

  diff.hunks.forEach((h, hi) => {
    const lines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    let anySelected = false;
    let prevEmitted = false;

    h.lines.forEach((l, li) => {
      const sel = selected.has(lineKey(hi, li));
      let out: string | null = null;
      switch (l.kind) {
        case 'context':
          out = ' ' + l.text; oldCount++; newCount++;
          break;
        case 'add':
          if (sel) { out = '+' + l.text; newCount++; anySelected = true; }
          else if (reverse) { out = ' ' + l.text; oldCount++; newCount++; }
          break;
        case 'del':
          if (sel) { out = '-' + l.text; oldCount++; anySelected = true; }
          else if (!reverse) { out = ' ' + l.text; oldCount++; newCount++; }
          break;
        case 'noNewline':
          if (prevEmitted) lines.push(NO_NEWLINE);
          return; // does not change prevEmitted
      }
      prevEmitted = out !== null;
      if (out !== null) lines.push(out);
    });

    if (!anySelected) return;
    // First line position (a 0-line side's start names the line before the hunk).
    let oldStart: number;
    let newStart: number;
    if (reverse) {
      // The patch is applied with --reverse against the diff's NEW side: its "+" side must match the target
      // as it is, so anchor on newStart. The emitted hunks before this one shift the "-" side by -delta,
      // and both sides of this hunk start at the same line (the target before/after differ only inside it).
      const first = (h.newLines === 0 ? h.newStart + 1 : h.newStart) - delta;
      oldStart = oldCount === 0 ? first - 1 : first;
      newStart = newCount === 0 ? first - 1 : first;
    } else {
      const oldFirst = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
      const newFirst = oldFirst + delta;
      oldStart = oldCount === 0 ? oldFirst - 1 : oldFirst;
      newStart = newCount === 0 ? newFirst - 1 : newFirst;
    }
    body.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const s of lines) body.push(s);
    delta += newCount - oldCount;
  });

  if (body.length === 0) return null;
  const header = [
    `diff --git ${headerPath('a/', path)} ${headerPath('b/', path)}`,
    `--- ${headerPath('a/', path)}`,
    `+++ ${headerPath('b/', path)}`,
  ];
  return header.concat(body).join('\n') + '\n';
}

/**
 * Whether line-level ops are allowed for this diff. `sideStatus` is the file's status on the side being
 * patched (StatusFile.unstaged for stage/discard, StatusFile.staged for unstage, ChangedFile.status in the
 * diff window). Added / deleted / untracked / conflicted / renamed / mode-changed / submodule / binary /
 * truncated files only get file-level ops.
 */
export function canPatchLines(diff: FileDiff, sideStatus: FileStatus | null | undefined): boolean {
  if (sideStatus !== 'modified') return false;
  if (diff.binary || diff.truncated) return false;
  if (diff.oldPath != null) return false;
  if (diff.oldMode !== diff.newMode) return false;
  if (diff.oldMode === '160000' || diff.newMode === '160000') return false; // gitlink
  return diff.hunks.length > 0;
}

/** ApplyPatchRequest for a mode (target / reverse mapping of the plan). */
export function patchRequest(path: string, patch: string, mode: PatchMode): ApplyPatchRequest {
  switch (mode) {
    case 'stage': return { path, patch, target: 'index', reverse: false };
    case 'unstage': return { path, patch, target: 'index', reverse: true };
    case 'discard': return { path, patch, target: 'worktree', reverse: true };
  }
}
