/// <reference types="node" />
// Deterministic fuzz of buildPatch against real `git apply` (stage / unstage / discard), multi-hunk diffs with
// 1 line of context and random partial selections. Skipped when git is not on PATH.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPatch, changeKeys, type PatchMode } from './patch';
import { expectedAfter, makeDiff } from './patchTestUtil';

function hasGit(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** mulberry32 */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Case { before: string; after: string; sel: Set<string>; diff: ReturnType<typeof makeDiff> }

function genCases(count: number, seed: number): Case[] {
  const rnd = prng(seed);
  const ri = (n: number) => Math.floor(rnd() * n);
  const alpha = ['a', 'b', 'c', 'd'];
  const out: Case[] = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 50) {
    const len = 20 + ri(40);
    const base = Array.from({ length: len }, () => alpha[ri(alpha.length)]);
    const edit = [...base];
    const nEdits = 3 + ri(8);
    for (let k = 0; k < nEdits; k++) {
      const p = ri(edit.length + 1);
      const r = rnd();
      if (r < 0.4 && edit.length > 0) edit.splice(Math.min(p, edit.length - 1), 1);
      else if (r < 0.8) edit.splice(p, 0, alpha[ri(alpha.length)] + alpha[ri(alpha.length)]);
      else if (edit.length > 0) edit[Math.min(p, edit.length - 1)] = 'x' + ri(10);
    }
    const before = base.join('\n') + '\n';
    const after = edit.length ? edit.join('\n') + '\n' : '';
    if (before === after || after === '') continue;
    const diff = makeDiff('f.txt', before, after, 1);
    if (diff.hunks.length < 2) continue;
    const keys = changeKeys(diff);
    // Bias toward omitted / partial hunks: per-hunk choice of none / some / all.
    const sel = new Set<string>();
    const byHunk = new Map<number, string[]>();
    for (const k of keys) { const h = Number(k.split(':')[0]); byHunk.set(h, [...(byHunk.get(h) ?? []), k]); }
    for (const ks of byHunk.values()) {
      const r = rnd();
      if (r < 0.3) continue;
      if (r < 0.6) ks.forEach((k) => sel.add(k));
      else ks.forEach((k) => { if (rnd() < 0.5) sel.add(k); });
    }
    if (sel.size === 0) continue;
    out.push({ before, after, sel, diff });
  }
  return out;
}

const MODES: PatchMode[] = ['stage', 'unstage', 'discard'];

describe.skipIf(!hasGit())('buildPatch fuzz vs git apply', () => {
  const cases = genCases(300, 0x5eed);

  it('generates enough multi-hunk cases', () => expect(cases.length).toBe(300));

  for (const mode of MODES) {
    it(`${mode}: every patch applies and yields the modelled result`, { timeout: 300_000 }, () => {
      const dir = mkdtempSync(join(tmpdir(), 'lanes-patch-fuzz-'));
      const git = (args: string[], input?: string) => execFileSync('git', args, { cwd: dir, input, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
      const failures: string[] = [];
      try {
        git(['init', '-q']);
        git(['config', 'user.email', 'fuzz@example.invalid']);
        git(['config', 'user.name', 'fuzz']);
        git(['config', 'core.autocrlf', 'false']);
        const file = join(dir, 'f.txt');
        cases.forEach((c, i) => {
          // stage: index = before, worktree = after. unstage: index = after. discard: worktree = after.
          writeFileSync(file, mode === 'stage' ? c.before : c.after);
          git(['add', 'f.txt']);
          if (mode === 'stage') writeFileSync(file, c.after);
          const patch = buildPatch(c.diff, c.sel, mode)!;
          const args = ['apply', ...(mode === 'discard' ? [] : ['--cached']), ...(mode === 'stage' ? [] : ['--reverse']), '--recount', '--whitespace=nowarn', '-'];
          try {
            git(args, patch);
          } catch (e) {
            failures.push(`#${i} apply failed: ${(e as { stderr?: Buffer }).stderr?.toString() ?? e}\n${patch}`);
            return;
          }
          const got = mode === 'discard' ? readFileSync(file, 'utf8') : git(['show', ':f.txt']);
          const exp = expectedAfter(c.before, c.after, c.diff, c.sel, mode);
          if (got !== exp) failures.push(`#${i} mismatch\n${patch}`);
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      expect(failures.slice(0, 3)).toEqual([]);
    });
  }
});
