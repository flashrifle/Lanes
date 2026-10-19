// StatusFile → ChangedFile mapping with the working-tree sentinels (see DiffRequest in src/types.ts). Pure.
import { REV_INDEX, REV_WORKTREE, type ChangedFile, type FileStatus, type StatusFile, type WorkingTreeStatus } from '../../types';

export type WorkingGroup = 'conflicts' | 'staged' | 'unstaged' | 'untracked';
export const GROUP_ORDER: readonly WorkingGroup[] = ['conflicts', 'staged', 'unstaged', 'untracked'];

/** One row of the Local Changes list. A file with staged and unstaged changes appears in both groups. */
export interface WorkingEntry {
  key: string;          // `${group}:${path}`, unique within the list
  group: WorkingGroup;
  file: StatusFile;
  change: ChangedFile;  // diff window entry (sentinel hashes)
  status: FileStatus;   // status on this group's side
}

const changed = (f: StatusFile, status: FileStatus, oldPath: string | null, fromHash: string | null, toHash: string): ChangedFile => ({
  path: f.path, oldPath, status, additions: null, deletions: null, binary: false, fromHash, toHash,
});

/** Staged side: (HEAD | empty tree, INDEX). */
export const stagedChange = (f: StatusFile, headHash: string | null): ChangedFile =>
  changed(f, f.staged ?? 'modified', f.oldPath, headHash, REV_INDEX);
/** Unstaged side: (INDEX, WORKTREE). Renames are a staged-side thing; this side is always the new path. */
export const unstagedChange = (f: StatusFile): ChangedFile => changed(f, f.unstaged ?? 'modified', null, REV_INDEX, REV_WORKTREE);
/** Untracked: (empty, WORKTREE) → backend runs `diff --no-index /dev/null path`. */
export const untrackedChange = (f: StatusFile): ChangedFile => changed(f, 'added', null, null, REV_WORKTREE);
/** Conflicted: (HEAD, WORKTREE), shows the conflict markers. */
export const conflictChange = (f: StatusFile, headHash: string | null): ChangedFile => changed(f, 'unmerged', null, headHash, REV_WORKTREE);

/** The rows of the Local Changes list in display order (groups in GROUP_ORDER, paths sorted within each). */
export function workingEntries(status: WorkingTreeStatus | null): WorkingEntry[] {
  if (!status) return [];
  const by: Record<WorkingGroup, WorkingEntry[]> = { conflicts: [], staged: [], unstaged: [], untracked: [] };
  const head = status.headHash;
  for (const f of status.files) {
    if (f.conflict) {
      by.conflicts.push({ key: 'conflicts:' + f.path, group: 'conflicts', file: f, change: conflictChange(f, head), status: 'unmerged' });
      continue;
    }
    if (f.untracked) {
      by.untracked.push({ key: 'untracked:' + f.path, group: 'untracked', file: f, change: untrackedChange(f), status: 'added' });
      continue;
    }
    if (f.staged) by.staged.push({ key: 'staged:' + f.path, group: 'staged', file: f, change: stagedChange(f, head), status: f.staged });
    if (f.unstaged) by.unstaged.push({ key: 'unstaged:' + f.path, group: 'unstaged', file: f, change: unstagedChange(f), status: f.unstaged });
  }
  const cmp = (a: WorkingEntry, b: WorkingEntry) => (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0);
  return GROUP_ORDER.flatMap((g) => by[g].sort(cmp));
}

export interface WorkingCounts { total: number; staged: number; unstaged: number; untracked: number; conflicts: number }

export function workingCounts(status: WorkingTreeStatus | null): WorkingCounts {
  const c: WorkingCounts = { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  if (!status) return c;
  c.total = status.files.length;
  for (const f of status.files) {
    if (f.conflict) c.conflicts++;
    else if (f.untracked) c.untracked++;
    else { if (f.staged) c.staged++; if (f.unstaged) c.unstaged++; }
  }
  return c;
}

/** Which side a diff-window entry shows, from its sentinel pair. */
export type WorkingSide = 'staged' | 'unstaged' | 'untracked' | 'conflict';
export function isWorkingRev(rev: string | null): boolean {
  return rev === REV_INDEX || rev === REV_WORKTREE;
}
export function workingSideOf(f: Pick<ChangedFile, 'fromHash' | 'toHash' | 'status'>): WorkingSide | null {
  if (f.toHash === REV_INDEX) return 'staged';
  if (f.toHash !== REV_WORKTREE) return null;
  if (f.fromHash === REV_INDEX) return 'unstaged';
  if (f.status === 'unmerged') return 'conflict';
  if (f.fromHash === null) return 'untracked';
  return 'conflict'; // (HEAD, WORKTREE) combined
}

/** Paths of the entries split for discard_files (tracked vs. untracked; staged rows mean "also reset the index"). */
export function discardRequestOf(entries: readonly WorkingEntry[]): { paths: string[]; untrackedPaths: string[]; includeStaged: boolean } {
  const paths = new Set<string>();
  const untracked = new Set<string>();
  let includeStaged = false;
  for (const e of entries) {
    if (e.group === 'untracked') untracked.add(e.file.path);
    else if (e.group === 'staged') { includeStaged = true; paths.add(e.file.path); if (e.file.oldPath) paths.add(e.file.oldPath); }
    else if (e.group === 'unstaged') paths.add(e.file.path);
  }
  return { paths: [...paths], untrackedPaths: [...untracked], includeStaged };
}
