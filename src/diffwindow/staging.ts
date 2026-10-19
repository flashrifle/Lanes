// Line / hunk staging helpers for the diff window (pure). Keys are FileDiff "h:l" (see ui/commit/patch.ts).
import type { ChangedFile, FileDiff } from '../types';
import { REV_INDEX, REV_WORKTREE } from '../types';
import { canPatchLines, type PatchMode } from '../ui/commit/patch';
import { workingSideOf, type WorkingSide } from '../ui/commit/workingFiles';
import type { DiffModel } from './align';

/** Selection keys of each change block (display "hunk"), in block order. */
export function blockKeys(model: DiffModel): string[][] {
  return model.blocks.map((b) => {
    const out: string[] = [];
    for (let i = b.uniStart; i < b.uniEnd; i++) {
      const r = model.uni[i];
      if ((r.kind === 'add' || r.kind === 'del') && r.line.key) out.push(r.line.key);
    }
    return out;
  });
}

/** New set with `keys` added (on) or removed (off). */
export function setKeys(sel: ReadonlySet<string>, keys: readonly string[], on: boolean): Set<string> {
  const next = new Set(sel);
  for (const k of keys) { if (on) next.add(k); else next.delete(k); }
  return next;
}

/** 'all' | 'some' | 'none' of `keys` in `sel`. */
export function coverage(sel: ReadonlySet<string>, keys: readonly string[]): 'all' | 'some' | 'none' {
  let n = 0;
  for (const k of keys) if (sel.has(k)) n++;
  return n === 0 ? 'none' : n === keys.length ? 'all' : 'some';
}

export interface StagingCaps {
  side: WorkingSide;
  /** Line-level modes allowed for the loaded diff ([] = file-level only). */
  lineModes: PatchMode[];
}

/** What the diff window may do for this entry; null = a commit diff (read-only). */
export function stagingCaps(file: ChangedFile, diff: FileDiff | null): StagingCaps | null {
  const side = workingSideOf(file);
  if (!side) return null;
  const lines = diff != null && canPatchLines(diff, file.status);
  if (side === 'unstaged') return { side, lineModes: lines ? ['stage', 'discard'] : [] };
  if (side === 'staged') return { side, lineModes: lines ? ['unstage'] : [] };
  return { side, lineModes: [] };
}

/** Header label for a revision: short hash, or the sentinel's name. */
export function revLabel(rev: string | null, names: { index: string; worktree: string }): string | null {
  if (rev === REV_INDEX) return names.index;
  if (rev === REV_WORKTREE) return names.worktree;
  return rev ? rev.slice(0, 8) : null;
}
