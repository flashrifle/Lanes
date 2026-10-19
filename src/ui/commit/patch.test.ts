/// <reference types="node" />
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DiffLine, FileDiff } from '../../types';
import { buildPatch, canPatchLines, changeKeys, headerPath, hunkKeys, lineKey, patchRequest, type PatchMode } from './patch';
import { expectedAfter, makeDiff } from './patchTestUtil';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join('');

/** Keys of lines matching the predicate. */
function pick(diff: FileDiff, pred: (l: DiffLine, hunk: number) => boolean): Set<string> {
  const s = new Set<string>();
  diff.hunks.forEach((h, hi) => h.lines.forEach((l, li) => { if ((l.kind === 'add' || l.kind === 'del') && pred(l, hi)) s.add(lineKey(hi, li)); }));
  return s;
}

interface Case {
  name: string;
  path?: string;
  old: string;   // diff old side
  new: string;   // diff new side
  mode: PatchMode;
  pick: (l: DiffLine, hunk: number) => boolean;
  context?: number;
  patch?: string; // exact expected patch, when spelled out
}

const base10 = lines(10);
const twentyFive = lines(25);

const cases: Case[] = [
  {
    name: 'stage-single-add',
    old: 'a\nb\nc\n', new: 'a\nb\nNEW\nc\n', mode: 'stage', pick: () => true,
    patch: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,4 @@\n a\n b\n+NEW\n c\n',
  },
  {
    name: 'stage-single-del',
    old: 'a\nb\nc\n', new: 'a\nc\n', mode: 'stage', pick: () => true,
    patch: 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,2 @@\n a\n-b\n c\n',
  },
  { name: 'stage-replace-both', old: base10, new: base10.replace('line 5\n', 'line five\n'), mode: 'stage', pick: () => true },
  { name: 'stage-replace-del-only', old: base10, new: base10.replace('line 5\n', 'line five\n'), mode: 'stage', pick: (l) => l.kind === 'del' },
  { name: 'stage-replace-add-only', old: base10, new: base10.replace('line 5\n', 'line five\n'), mode: 'stage', pick: (l) => l.kind === 'add' },
  {
    name: 'stage-mixed-in-hunk',
    old: base10,
    new: base10.replace('line 4\n', 'line 4\nins A\nins B\n').replace('line 6\n', '').replace('line 7\n', 'line seven\n'),
    mode: 'stage',
    pick: (l) => l.text === 'ins B' || l.text === 'line 6' || l.text === 'line seven',
  },
  {
    name: 'stage-multi-hunk-second-only',
    old: twentyFive,
    new: twentyFive.replace('line 2\n', 'line 2\nX1\nX2\n').replace('line 12\n', 'line twelve\n').replace('line 22\n', ''),
    mode: 'stage',
    pick: (_l, h) => h === 1,
  },
  {
    name: 'stage-multi-hunk-first-and-third',
    old: twentyFive,
    new: twentyFive.replace('line 2\n', 'line 2\nX1\nX2\n').replace('line 12\n', 'line twelve\n').replace('line 22\n', ''),
    mode: 'stage',
    pick: (l, h) => (h === 0 && l.text === 'X2') || h === 2,
  },
  {
    name: 'stage-multi-hunk-third-only',
    old: twentyFive,
    new: twentyFive.replace('line 2\n', 'line 2\nX1\nX2\n').replace('line 12\n', 'line twelve\n').replace('line 22\n', 'Y\n'),
    mode: 'stage',
    pick: (_l, h) => h === 2,
  },
  { name: 'stage-insert-at-top', old: base10, new: 'top\n' + base10, mode: 'stage', pick: () => true },
  { name: 'stage-noeol-old-add-line', old: 'a\nb', new: 'a\nb\nc\n', mode: 'stage', pick: () => true },
  { name: 'stage-noeol-new-select-del', old: 'a\nb\nc\n', new: 'a\nb\nz', mode: 'stage', pick: (l) => l.kind === 'del' },
  { name: 'stage-noeol-new-select-add', old: 'a\nb\nc\n', new: 'a\nb\nc\nz', mode: 'stage', pick: (l) => l.kind === 'add' },
  { name: 'stage-noeol-both-change-last', old: 'a\nb\nc', new: 'a\nb\nC', mode: 'stage', pick: () => true },
  { name: 'stage-crlf', old: 'a\r\nb\r\nc\r\n', new: 'a\r\nB\r\nc\r\nd\r\n', mode: 'stage', pick: (l) => l.text !== 'd\r' },
  { name: 'stage-quoted-path', path: 'dir/we"ird\\name.txt', old: 'a\nb\n', new: 'a\nB\n', mode: 'stage', pick: () => true },
  { name: 'stage-trailing-space-path', path: 'trail ', old: 'a\nb\n', new: 'a\nb\nc\n', mode: 'stage', pick: () => true },
  { name: 'stage-unicode-path', path: '한글/파일.txt', old: 'a\n', new: 'a\nb\n', mode: 'stage', pick: () => true },
  { name: 'unstage-single-add', old: 'a\nb\nc\n', new: 'a\nb\nNEW\nc\n', mode: 'unstage', pick: () => true },
  { name: 'unstage-replace-add-only', old: base10, new: base10.replace('line 5\n', 'line five\n'), mode: 'unstage', pick: (l) => l.kind === 'add' },
  { name: 'unstage-replace-del-only', old: base10, new: base10.replace('line 5\n', 'line five\n'), mode: 'unstage', pick: (l) => l.kind === 'del' },
  {
    name: 'unstage-multi-hunk-second-only',
    old: twentyFive,
    new: twentyFive.replace('line 2\n', 'line 2\nX1\nX2\n').replace('line 12\n', 'line twelve\n').replace('line 22\n', ''),
    mode: 'unstage',
    pick: (_l, h) => h === 1,
  },
  {
    // first hunk (+2) omitted: the reverse anchor must subtract nothing, the diff's newStart is already right
    name: 'unstage-multi-hunk-third-only',
    old: twentyFive,
    new: twentyFive.replace('line 2\n', 'line 2\nX1\nX2\n').replace('line 12\n', 'line twelve\n').replace('line 22\n', ''),
    mode: 'unstage',
    pick: (_l, h) => h === 2,
  },
  {
    // first hunk partially selected (1 of 2 adds), then the third
    name: 'unstage-multi-hunk-partial-first-and-third',
    old: twentyFive,
    new: twentyFive.replace('line 2\n', 'line 2\nX1\nX2\n').replace('line 12\n', 'line twelve\n').replace('line 22\n', 'Y\n'),
    mode: 'unstage',
    pick: (l, h) => (h === 0 && l.text === 'X1') || h === 2,
  },
  {
    name: 'discard-multi-hunk-second-only',
    old: twentyFive,
    new: twentyFive.replace('line 2\n', 'line 2\nX1\nX2\n').replace('line 12\n', 'line twelve\n').replace('line 22\n', ''),
    mode: 'discard',
    pick: (_l, h) => h === 1,
  },
  {
    // first hunk deletes 2 lines and is partially selected; later hunks shift on the new side
    name: 'discard-multi-hunk-partial-del-then-add',
    old: twentyFive,
    new: twentyFive.replace('line 3\nline 4\n', '').replace('line 15\n', 'line 15\nZ1\n').replace('line 23\n', 'line 23\nZ2\n'),
    mode: 'discard',
    pick: (l, h) => (h === 0 && l.text === 'line 4') || (h === 2),
  },
  { name: 'unstage-noeol-new', old: 'a\nb\nc\n', new: 'a\nb\nc\nz', mode: 'unstage', pick: () => true },
  { name: 'discard-mixed', old: base10, new: base10.replace('line 3\n', 'L3\n').replace('line 8\n', 'line 8\nadded\n'), mode: 'discard', pick: (l) => l.text === 'added' || l.text === 'line 3' },
  { name: 'discard-crlf', old: 'a\r\nb\r\n', new: 'a\r\nB\r\n', mode: 'discard', pick: (l) => l.kind === 'add' },
  { name: 'discard-full-context', old: base10, new: base10.replace('line 2\n', 'two\n').replace('line 9\n', 'nine\n'), mode: 'discard', pick: (l) => l.text === 'nine' || l.text === 'line 9', context: 1_000_000 },
  { name: 'stage-full-context-partial', old: twentyFive, new: twentyFive.replace('line 3\n', 'three\n').replace('line 20\n', 'twenty\n'), mode: 'stage', pick: (l) => l.text.includes('20') || l.text === 'twenty', context: 1_000_000 },
];

describe('buildPatch matrix', () => {
  for (const c of cases) {
    it(c.name, () => {
      const path = c.path ?? 'f.txt';
      const diff = makeDiff(path, c.old, c.new, c.context ?? 3);
      const sel = pick(diff, c.pick);
      expect(sel.size).toBeGreaterThan(0);
      const patch = buildPatch(diff, sel, c.mode);
      expect(patch).not.toBeNull();
      if (c.patch) expect(patch).toBe(c.patch);
      expect(patch!.startsWith('diff --git ')).toBe(true);
      expect(patch!.endsWith('\n')).toBe(true);
      // hunk headers agree with their bodies
      for (const chunk of patch!.split(/^(?=@@ )/m).slice(1)) {
        const m = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@\n/.exec(chunk)!;
        const body = chunk.slice(m[0].length).split('\n').filter((s) => s !== '' && !s.startsWith('\\'));
        expect(body.filter((s) => s[0] !== '+').length).toBe(Number(m[2]));
        expect(body.filter((s) => s[0] !== '-').length).toBe(Number(m[4]));
      }
      const before = c.mode === 'stage' ? c.old : c.new;
      const after = expectedAfter(c.old, c.new, diff, sel, c.mode);
      writeFixture(c.name, { before, after, diff, selection: [...sel], mode: c.mode, patch: patch! });
    });
  }
});

describe('buildPatch details', () => {
  const diff = makeDiff('f.txt', lines(25), lines(25).replace('line 2\n', 'line 2\nX1\nX2\n').replace('line 12\n', 'line twelve\n').replace('line 22\n', ''));

  it('empty selection → null', () => {
    expect(buildPatch(diff, new Set(), 'stage')).toBeNull();
    // keys of context lines are not a selection
    expect(buildPatch(diff, new Set([lineKey(0, 0)]), 'stage')).toBeNull();
  });

  it('newStart follows the cumulative delta of emitted hunks only', () => {
    expect(diff.hunks.length).toBe(3);
    const second = buildPatch(diff, new Set(hunkKeys(diff, 1)), 'stage')!;
    const h1 = diff.hunks[1];
    expect(second).toContain(`@@ -${h1.oldStart},${h1.oldLines} +${h1.oldStart},${h1.newLines} @@`);
    const all = buildPatch(diff, new Set(changeKeys(diff)), 'stage')!;
    // with everything selected the headers equal git's own
    for (const h of diff.hunks) expect(all).toContain(h.header);
  });

  it('unstage turns unselected adds into context and drops unselected dels', () => {
    const d = makeDiff('f.txt', 'a\nb\nc\n', 'a\nB\nc\n');
    const p = buildPatch(d, pick(d, (l) => l.kind === 'del'), 'unstage')!;
    expect(p).toBe('diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,4 +1,3 @@\n a\n-b\n B\n c\n');
  });

  it('noNewline is emitted only after an emitted line', () => {
    const d = makeDiff('f.txt', 'a\nb\n', 'a\nb\nz');
    expect(d.hunks[0].lines.some((l) => l.kind === 'noNewline')).toBe(true);
    // stage with nothing → null; unstage of nothing → null
    const sel = pick(d, () => true);
    expect(buildPatch(d, sel, 'stage')).toContain('+z\n\\ No newline at end of file\n');
    // in a forward patch an unselected add is dropped, and so is its marker
    const d2 = makeDiff('f.txt', 'a\nb\nc\n', 'a\nB\nc\nz');
    const p2 = buildPatch(d2, pick(d2, (l) => l.text === 'B' || l.text === 'b'), 'stage')!;
    expect(p2).not.toContain('No newline');
    // in a reverse patch it becomes context and keeps the marker
    const p3 = buildPatch(d2, pick(d2, (l) => l.text === 'B' || l.text === 'b'), 'unstage')!;
    expect(p3).toContain(' z\n\\ No newline at end of file\n');
  });

  it('CR stays part of the line', () => {
    const d = makeDiff('f.txt', 'a\r\nb\r\n', 'a\r\nB\r\n');
    expect(buildPatch(d, pick(d, () => true), 'stage')).toContain('-b\r\n+B\r\n');
  });
});

describe('headerPath', () => {
  it('quotes only when needed', () => {
    expect(headerPath('a/', 'src/x.ts')).toBe('a/src/x.ts');
    expect(headerPath('a/', 'with space.txt')).toBe('a/with space.txt');
    expect(headerPath('a/', '한글.txt')).toBe('a/한글.txt');
    expect(headerPath('b/', 'q"uote')).toBe('"b/q\\"uote"');
    expect(headerPath('a/', 'back\\slash')).toBe('"a/back\\\\slash"');
    expect(headerPath('a/', 'tab\there')).toBe('"a/tab\\there"');
    expect(headerPath('a/', 'nl\nx')).toBe('"a/nl\\nx"');
    expect(headerPath('a/', 'ctl\x01')).toBe('"a/ctl\\001"');
    expect(headerPath('a/', ' lead')).toBe('"a/ lead"');
    expect(headerPath('a/', 'trail ')).toBe('"a/trail "');
  });
  it('header uses the quoted form on all three lines', () => {
    const d = makeDiff('q"x', 'a\n', 'b\n');
    const p = buildPatch(d, pick(d, () => true), 'stage')!;
    expect(p.split('\n').slice(0, 3)).toEqual(['diff --git "a/q\\"x" "b/q\\"x"', '--- "a/q\\"x"', '+++ "b/q\\"x"']);
  });
});

describe('canPatchLines', () => {
  const d = makeDiff('f.txt', 'a\n', 'b\n');
  it('allows plain modified files', () => expect(canPatchLines(d, 'modified')).toBe(true));
  it('rejects other statuses', () => {
    for (const s of ['added', 'deleted', 'renamed', 'copied', 'typeChanged', 'unmerged', 'unknown', null] as const) expect(canPatchLines(d, s)).toBe(false);
  });
  it('rejects binary / truncated / renamed / mode change / gitlink / empty', () => {
    expect(canPatchLines({ ...d, binary: true }, 'modified')).toBe(false);
    expect(canPatchLines({ ...d, truncated: true }, 'modified')).toBe(false);
    expect(canPatchLines({ ...d, oldPath: 'old.txt' }, 'modified')).toBe(false);
    expect(canPatchLines({ ...d, newMode: '100755' }, 'modified')).toBe(false);
    expect(canPatchLines({ ...d, oldMode: '160000', newMode: '160000' }, 'modified')).toBe(false);
    expect(canPatchLines({ ...d, hunks: [] }, 'modified')).toBe(false);
  });
});

describe('patchRequest', () => {
  it('maps modes to target / reverse', () => {
    expect(patchRequest('p', 'x', 'stage')).toEqual({ path: 'p', patch: 'x', target: 'index', reverse: false });
    expect(patchRequest('p', 'x', 'unstage')).toEqual({ path: 'p', patch: 'x', target: 'index', reverse: true });
    expect(patchRequest('p', 'x', 'discard')).toEqual({ path: 'p', patch: 'x', target: 'worktree', reverse: true });
  });
});

/** Golden fixture for the Rust side (src-tauri applies `patch` to `before` and expects `after`). Written only on change. */
function writeFixture(name: string, data: { before: string; after: string; diff: FileDiff; selection: string[]; mode: PatchMode; patch: string }): void {
  if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true });
  const file = join(FIXTURE_DIR, `${name}.json`);
  const text = JSON.stringify(data, null, 2) + '\n';
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return;
  writeFileSync(file, text);
}
