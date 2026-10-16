import { describe, expect, it } from 'vitest';
import type { DiffLine, FileDiff } from '../types';
import { buildDiffModel, buildDisplay, displayCols, sbsKinds, uniKinds } from './align';

const ctx = (o: number, n: number, text: string): DiffLine => ({ kind: 'context', oldLine: o, newLine: n, text });
const del = (o: number, text: string): DiffLine => ({ kind: 'del', oldLine: o, newLine: null, text });
const add = (n: number, text: string): DiffLine => ({ kind: 'add', oldLine: null, newLine: n, text });
const nonl: DiffLine = { kind: 'noNewline', oldLine: null, newLine: null, text: 'No newline at end of file' };

function fd(lines: DiffLine[], extra: Partial<FileDiff> = {}, h: Partial<FileDiff['hunks'][number]> = {}): FileDiff {
  const oldLines = lines.filter((l) => l.kind === 'context' || l.kind === 'del').length;
  const newLines = lines.filter((l) => l.kind === 'context' || l.kind === 'add').length;
  return {
    path: 'a.ts', oldPath: null, binary: false, oldMode: null, newMode: null, truncated: false,
    hunks: [{
      header: '@@', oldStart: oldLines ? 1 : 0, oldLines, newStart: newLines ? 1 : 0, newLines, lines, ...h,
    }],
    ...extra,
  };
}

describe('buildDiffModel', () => {
  it('added file: everything on the right, left filler', () => {
    const m = buildDiffModel(fd([add(1, 'a'), add(2, 'b')]));
    expect(m.blocks).toHaveLength(1);
    expect(m.blocks[0]).toMatchObject({ type: 'insert', sbsStart: 0, sbsEnd: 2, addCount: 2, delCount: 0 });
    expect(m.sbs.map((r) => [r.left?.line ?? null, r.right?.line ?? null])).toEqual([[null, 1], [null, 2]]);
    expect(m.uni.map((r) => r.kind)).toEqual(['add', 'add']);
  });

  it('deleted file: everything on the left, right filler', () => {
    const m = buildDiffModel(fd([del(1, 'a'), del(2, 'b'), del(3, 'c')]));
    expect(m.blocks[0]).toMatchObject({ type: 'delete', delCount: 3, addCount: 0 });
    expect(m.sbs.every((r) => r.right === null && r.left !== null)).toBe(true);
  });

  it('modify block of unequal size pads the shorter side and keeps equal lines aligned', () => {
    const m = buildDiffModel(fd([
      ctx(1, 1, 'top'),
      del(2, 'const a = 1;'),
      add(2, 'const a = 2;'),
      add(3, 'const b = 3;'),
      add(4, 'const c = 4;'),
      ctx(3, 5, 'bottom'),
    ]));
    expect(m.sbs.map((r) => r.kind)).toEqual(['equal', 'change', 'change', 'change', 'equal']);
    expect(m.sbs.map((r) => [r.left?.line ?? null, r.right?.line ?? null])).toEqual([
      [1, 1], [2, 2], [null, 3], [null, 4], [3, 5],
    ]);
    const b = m.blocks[0];
    expect(b).toMatchObject({ type: 'modify', sbsStart: 1, sbsEnd: 4, uniStart: 1, uniEnd: 5 });
    // word-level: "1" vs "2" on the paired line
    const l = m.sbs[1].left!;
    const r = m.sbs[1].right!;
    expect(l.hl!.map(([s, e]) => l.text.slice(s, e))).toEqual(['1']);
    expect(r.hl!.map(([s, e]) => r.text.slice(s, e))).toEqual(['2']);
    expect(m.uni.map((u) => u.kind)).toEqual(['equal', 'del', 'add', 'add', 'add', 'equal']);
  });

  it('pairs similar lines inside a block, padding before an inserted line', () => {
    const m = buildDiffModel(fd([del(1, 'const a = 1;'), add(1, '// brand new comment here'), add(2, 'const a = 2;')]));
    expect(m.sbs.map((r) => [r.left?.line ?? null, r.right?.line ?? null])).toEqual([[null, 1], [1, 2]]);
    const r = m.sbs[1].right!;
    expect(r.hl!.map(([s, e]) => r.text.slice(s, e))).toEqual(['2']);
    expect(m.sbs[0].right!.hl).toEqual([[0, 25]]);
  });

  it('dissimilar modify block falls back to plain tint (hl null)', () => {
    const m = buildDiffModel(fd([del(1, 'import React from "react";'), add(1, 'while (true) { go(); }')]));
    expect(m.sbs[0].left!.hl).toBeNull();
    expect(m.sbs[0].right!.hl).toBeNull();
  });

  it('multiple blocks get sequential indices', () => {
    const m = buildDiffModel(fd([del(1, 'x'), ctx(2, 1, 'k'), add(2, 'y')]));
    expect(m.blocks.map((b) => b.type)).toEqual(['delete', 'insert']);
    expect(m.sbs.map((r) => r.block)).toEqual([0, -1, 1]);
  });

  it('rename with content change keeps paths untouched and builds blocks', () => {
    const m = buildDiffModel(fd([ctx(1, 1, 'a'), del(2, 'b'), add(2, 'B')], { path: 'new.ts', oldPath: 'old.ts' }));
    expect(m.blocks).toHaveLength(1);
    expect(m.blocks[0].type).toBe('modify');
  });

  it('pure rename / empty file: no hunks → empty model', () => {
    const m = buildDiffModel({
      path: 'new.ts', oldPath: 'old.ts', binary: false, oldMode: null, newMode: null, hunks: [], truncated: false,
    });
    expect(m.sbs).toEqual([]);
    expect(m.blocks).toEqual([]);
  });

  it('no newline at EOF marks the right line and still is a change', () => {
    const m = buildDiffModel(fd([ctx(1, 1, 'a'), del(2, 'end'), nonl, add(2, 'end')]));
    expect(m.blocks).toHaveLength(1);
    const row = m.sbs[1];
    expect(row.left!.noNewline).toBe(true);
    expect(row.right!.noNewline).toBe(false);
    expect(row.left!.hl).toEqual([]);
  });

  it('no newline on a context line marks both sides', () => {
    const m = buildDiffModel(fd([add(1, 'new'), ctx(1, 2, 'last'), nonl]));
    const last = m.sbs[1];
    expect(last.left!.noNewline && last.right!.noNewline).toBe(true);
  });

  it('inserts a gap row between non-adjacent hunks', () => {
    const d: FileDiff = {
      path: 'a', oldPath: null, binary: false, oldMode: null, newMode: null, truncated: false,
      hunks: [
        { header: '', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [del(1, 'a'), add(1, 'A')] },
        { header: '', oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: [ctx(10, 10, 'j')] },
      ],
    };
    const m = buildDiffModel(d);
    expect(m.sbs.map((r) => r.kind)).toEqual(['change', 'gap', 'equal']);
    expect(m.sbs[1].kind === 'gap' && m.sbs[1].count).toBe(8);
  });

  it('computes display widths (Hangul = 2 cols)', () => {
    expect(displayCols('ab')).toBe(2);
    expect(displayCols('가나')).toBe(4);
    expect(displayCols('\t')).toBe(4);
    const m = buildDiffModel(fd([ctx(1, 1, 'xx'), add(2, '가나다')]));
    expect(m.leftCols).toBe(2);
    expect(m.rightCols).toBe(6);
  });
});

describe('buildDisplay', () => {
  const lines: DiffLine[] = [];
  for (let i = 1; i <= 20; i++) lines.push(ctx(i, i, 'l' + i));
  lines.push(del(21, 'x'), add(21, 'y'));
  for (let i = 22; i <= 41; i++) lines.push(ctx(i, i, 'l' + i));
  const m = buildDiffModel(fd(lines));

  it('no collapse → one item per row', () => {
    const d = buildDisplay(sbsKinds(m), { collapse: false, expanded: new Set() });
    expect(d.items).toHaveLength(m.sbs.length);
  });

  it('collapse keeps 3 lines around changes and folds the rest', () => {
    const d = buildDisplay(sbsKinds(m), { collapse: true, expanded: new Set() });
    expect(d.items[0]).toEqual({ kind: 'fold', start: 0, end: 17 });
    const last = d.items[d.items.length - 1];
    expect(last).toEqual({ kind: 'fold', start: 24, end: 41 });
    expect(d.items).toHaveLength(1 + 3 + 1 + 3 + 1);
    expect(d.rowToItem[20]).toBe(4);
    expect(d.rowToItem[5]).toBe(0);
  });

  it('expanded folds are shown', () => {
    const d = buildDisplay(sbsKinds(m), { collapse: true, expanded: new Set([0]) });
    expect(d.items[0]).toEqual({ kind: 'row', index: 0 });
    expect(d.items.filter((i) => i.kind === 'fold')).toHaveLength(1);
  });

  it('short runs are not folded and unchanged files are never folded', () => {
    const small = buildDiffModel(fd([ctx(1, 1, 'a'), del(2, 'b'), ctx(3, 2, 'c')]));
    expect(buildDisplay(uniKinds(small), { collapse: true, expanded: new Set() }).items.every((i) => i.kind === 'row')).toBe(true);
    const same = buildDiffModel(fd(lines.filter((l) => l.kind === 'context')));
    expect(buildDisplay(sbsKinds(same), { collapse: true, expanded: new Set() }).items).toHaveLength(same.sbs.length);
  });
});
