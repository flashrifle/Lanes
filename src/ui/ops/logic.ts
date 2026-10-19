// Pure helpers for ui-ops (no DOM / Tauri imports): menu enablement, ordering, compare mapping, push form state.
import type { AppError, GraphLayout, PushPreview, PushRequest, Ref, RefsSnapshot, RepoOperation, ResetMode, RevRange } from '../../types';
import type { Key } from '../../i18n';

// ───────────── ordering ─────────────
/** `hashes` arrive in row order (newest first). Cherry-pick applies OLDEST first. */
export const pickOrder = (hashes: readonly string[]): string[] => [...hashes].reverse();
/** Revert applies NEWEST first = row order. */
export const revertOrder = (hashes: readonly string[]): string[] => [...hashes];

/** Highest parent count among the commits (>1 = at least one merge → ask for mainline); 0 when empty. */
export const maxParents = (parentCounts: readonly number[]): number => parentCounts.reduce((m, n) => Math.max(m, n), 0);
export const needsMainline = (parentCounts: readonly number[]): boolean => maxParents(parentCounts) > 1;

// ───────────── head context / menu enablement ─────────────
export interface HeadCtx {
  detached: boolean;
  unborn: boolean;
  branch: string | null;
  fullName: string | null;
  hash: string | null;
  operation: RepoOperation | null;
}

export function headCtxOf(refs: RefsSnapshot | undefined | null): HeadCtx {
  const h = refs?.head;
  return {
    detached: h?.detached ?? false, unborn: h?.unborn ?? true, branch: h?.branch ?? null,
    fullName: h?.fullName ?? null, hash: h?.hash ?? null, operation: refs?.operation ?? null,
  };
}

/** Rev name meaning "the current checkout" for compare / merge-base purposes. */
export const currentRev = (h: HeadCtx): string => h.fullName ?? h.hash ?? 'HEAD';

export interface CommitMenuState { cherryPick: boolean; revert: boolean; reset: boolean; tag: boolean; compare: boolean }

export function commitMenuState(h: HeadCtx, hashes: readonly string[], focusHash: string): CommitMenuState {
  const writable = !h.unborn && h.operation == null && hashes.length > 0;
  return {
    cherryPick: writable,
    revert: writable,
    reset: writable && hashes.length === 1,
    tag: hashes.length === 1,
    compare: !h.unborn && hashes.length === 1 && focusHash !== h.hash,
  };
}

/**
 * "Undo Commit…" (IntelliJ): soft reset of the current branch to HEAD's first parent. Allowed only for exactly one
 * targeted commit that is HEAD on a branch (not detached / unborn), has a parent, and with no operation running.
 * `parentCount` = parents of that commit (null = unknown).
 */
export function canUndoCommit(h: HeadCtx, hashes: readonly string[], parentCount: number | null): boolean {
  return hashes.length === 1 && h.hash != null && hashes[0] === h.hash
    && !h.detached && !h.unborn && h.branch != null && h.operation == null
    && parentCount != null && parentCount > 0;
}

/**
 * Whether HEAD is already on the remote: it has an upstream and is not ahead of it (ahead 0 = upstream contains
 * HEAD). An upstream with unknown ahead (gone / not computed) counts as pushed, to warn rather than not.
 */
export function headIsPushed(status: { upstream: string | null; ahead: number | null } | null | undefined): boolean {
  if (!status || status.upstream == null) return false;
  return status.ahead == null || status.ahead === 0;
}

export interface BranchMenuState { merge: boolean; rebase: boolean; compare: boolean; push: boolean; reflog: boolean }

export function branchMenuState(h: HeadCtx, ref: Ref): BranchMenuState {
  const isBranch = ref.type === 'localBranch' || ref.type === 'remoteBranch';
  const same = ref.type === 'localBranch' && ref.isCurrent;
  const free = !h.unborn && h.operation == null;
  return {
    merge: isBranch && !same && free,
    rebase: isBranch && !same && free && !h.detached,
    compare: ref.type !== 'head' && !same && !h.unborn,
    push: ref.type === 'localBranch',
    reflog: ref.type === 'localBranch' || ref.type === 'head',
  };
}

// ───────────── compare ─────────────
/** Compare A with B: commits reachable from A and not from B (`rev-list A ^B`). Swap to see the other side. */
export const compareToRevRange = (a: string, b: string): RevRange => ({ include: a, exclude: b });
export const swapRevRange = (r: RevRange): RevRange => ({ include: r.exclude, exclude: r.include });
export const sameRevRange = (a: RevRange | null, b: RevRange | null): boolean =>
  a === b || (!!a && !!b && a.include === b.include && a.exclude === b.exclude);

// ───────────── branch line highlight ─────────────
/** layout.lineKey(layout.lineOfRef(fullName)) when the graph engine provides it, else the documented key format. */
export function highlightKeyFor(ref: Ref, layout: Pick<GraphLayout, 'lineOfRef' | 'lineKey'> | null): string | null {
  if (ref.type === 'head') return 'HEAD';
  if (layout) {
    const line = layout.lineOfRef(ref.fullName);
    if (line >= 0) {
      const key = layout.lineKey(line);
      if (key) return key;
    }
  }
  if (ref.type === 'localBranch') return 'b:' + ref.name;
  if (ref.type === 'tag') return 'tag:' + ref.name;
  return null;
}

// ───────────── errors ─────────────
/** i18n key explaining an error code in terms of what the user should do; null = show the raw message. */
export function explainErrorKey(code: AppError['code']): Key | null {
  switch (code) {
    case 'dirtyWorktree': return 'ops.err.dirty';
    case 'wouldOverwrite': return 'ops.err.overwrite';
    case 'unmergedFiles': return 'ops.err.unmerged';
    case 'busy': return 'ops.err.busy';
    case 'authFailed': return 'ops.err.auth';
    case 'nothingToCommit': return 'ops.err.nothing';
    default: return null;
  }
}

// ───────────── reset ─────────────
/** Word that must be typed to confirm a hard reset: the branch name, or "HEAD" when detached. */
export const resetConfirmWord = (h: HeadCtx): string => (h.detached || !h.branch ? 'HEAD' : h.branch);
export const resetReady = (mode: ResetMode, typed: string, word: string): boolean => mode !== 'hard' || typed.trim() === word;

// ───────────── push dialog ─────────────
export interface PushForm { remote: string; remoteBranch: string; setUpstream: boolean; followTags: boolean }

export function initPushForm(p: PushPreview): PushForm {
  return { remote: p.remote ?? '', remoteBranch: p.remoteBranch, setUpstream: p.upstream == null, followTags: false };
}

/** Is there anything meaningful to push? (a fresh remote branch or -u is always meaningful) */
export function canPush(p: PushPreview, f: PushForm): boolean {
  if (!f.remote || !f.remoteBranch.trim()) return false;
  return p.outgoing.length > 0 || p.remoteHash == null || f.setUpstream;
}

/** The preview's remoteHash only describes the previewed remote branch; force-with-lease is offered only for that one. */
export const canForce = (p: PushPreview, f: PushForm): boolean =>
  p.remoteHash != null && f.remote === p.remote && f.remoteBranch.trim() === p.remoteBranch;

export function buildPushRequest(p: PushPreview, f: PushForm, force: boolean): PushRequest {
  return {
    remote: f.remote,
    localBranch: p.localBranch,
    remoteBranch: f.remoteBranch.trim(),
    setUpstream: f.setUpstream,
    forceWithLease: force && canForce(p, f) ? p.remoteHash : null,
    followTags: f.followTags,
  };
}

export type PushFailure = 'rejected' | 'stale' | 'other';
export const pushFailureOf = (e: AppError): PushFailure =>
  e.code === 'pushRejected' ? 'rejected' : e.code === 'staleLease' ? 'stale' : 'other';

export const shortHash = (h: string | null | undefined): string => (h ? h.slice(0, 8) : '');
