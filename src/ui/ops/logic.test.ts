import { describe, expect, it } from 'vitest';
import type { PushPreview, Ref } from '../../types';
import {
  branchMenuState, buildPushRequest, canForce, canPush, commitMenuState, compareToRevRange, explainErrorKey, headCtxOf,
  highlightKeyFor, initPushForm, needsMainline, pickOrder, pushFailureOf, resetConfirmWord, resetReady, revertOrder,
  swapRevRange, type HeadCtx,
} from './logic';
import { EMPTY_FILTER_UI, isFilterEmpty, toLogFilter } from '../state/logic';

const head = (p: Partial<HeadCtx> = {}): HeadCtx => ({
  detached: false, unborn: false, branch: 'main', fullName: 'refs/heads/main', hash: 'h0', operation: null, ...p,
});
const ref = (p: Partial<Ref>): Ref => ({
  name: 'x', fullName: 'refs/heads/x', type: 'localBranch', hash: 'h1', index: 1, remote: null, upstream: null,
  ahead: null, behind: null, upstreamGone: false, isCurrent: false, isFavorite: false, ...p,
});
const preview = (p: Partial<PushPreview> = {}): PushPreview => ({
  localBranch: 'main', remotes: ['origin', 'up'], remote: 'origin', remoteBranch: 'main', upstream: 'refs/remotes/origin/main',
  remoteHash: 'r'.repeat(40), outgoing: [{ hash: 'a', subject: 's', authorName: 'n', authorTime: 1 }], behind: 0, ...p,
});

describe('ordering', () => {
  it('cherry-pick oldest first, revert newest first', () => {
    const rows = ['new', 'mid', 'old'];
    expect(pickOrder(rows)).toEqual(['old', 'mid', 'new']);
    expect(revertOrder(rows)).toEqual(['new', 'mid', 'old']);
    expect(rows).toEqual(['new', 'mid', 'old']);
  });
  it('mainline only for merges', () => {
    expect(needsMainline([1, 1])).toBe(false);
    expect(needsMainline([1, 2])).toBe(true);
    expect(needsMainline([])).toBe(false);
  });
});

describe('menu state', () => {
  it('commit menu', () => {
    expect(commitMenuState(head(), ['a', 'b'], 'a')).toMatchObject({ cherryPick: true, revert: true, reset: false, tag: false, compare: false });
    expect(commitMenuState(head(), ['a'], 'a')).toMatchObject({ reset: true, tag: true, compare: true });
    expect(commitMenuState(head(), ['h0'], 'h0').compare).toBe(false);
    expect(commitMenuState(head({ operation: 'rebase' }), ['a'], 'a')).toMatchObject({ cherryPick: false, revert: false, reset: false });
    expect(commitMenuState(head({ unborn: true }), ['a'], 'a').cherryPick).toBe(false);
  });
  it('branch menu', () => {
    expect(branchMenuState(head(), ref({}))).toMatchObject({ merge: true, rebase: true, compare: true, push: true });
    expect(branchMenuState(head(), ref({ isCurrent: true }))).toMatchObject({ merge: false, rebase: false, compare: false, push: true });
    expect(branchMenuState(head({ detached: true }), ref({}))).toMatchObject({ merge: true, rebase: false });
    expect(branchMenuState(head(), ref({ type: 'remoteBranch' }))).toMatchObject({ merge: true, push: false });
    expect(branchMenuState(head(), ref({ type: 'tag' }))).toMatchObject({ merge: false, compare: true, push: false });
    expect(branchMenuState(head({ operation: 'merge' }), ref({})).merge).toBe(false);
  });
  it('headCtxOf defaults to unborn', () => {
    expect(headCtxOf(null).unborn).toBe(true);
  });
});

describe('compare → revRange', () => {
  it('maps and swaps', () => {
    const r = compareToRevRange('refs/heads/a', 'refs/heads/b');
    expect(r).toEqual({ include: 'refs/heads/a', exclude: 'refs/heads/b' });
    expect(swapRevRange(r)).toEqual({ include: 'refs/heads/b', exclude: 'refs/heads/a' });
  });
  it('flows through toLogFilter and counts as a non-empty filter', () => {
    const rr = compareToRevRange('a', 'b');
    const f = toLogFilter({ ...EMPTY_FILTER_UI, revRange: rr });
    expect(f.revRange).toEqual(rr);
    expect(isFilterEmpty(f)).toBe(false);
    expect(toLogFilter(EMPTY_FILTER_UI).revRange).toBeNull();
    expect(isFilterEmpty(toLogFilter(EMPTY_FILTER_UI))).toBe(true);
  });
});

describe('highlight key', () => {
  it('prefers the layout, falls back to documented format', () => {
    const layout = { lineOfRef: () => 3, lineKey: (n: number) => 'b:main#' + n };
    expect(highlightKeyFor(ref({ name: 'main' }), layout)).toBe('b:main#3');
    const stub = { lineOfRef: () => -1, lineKey: () => '' };
    expect(highlightKeyFor(ref({ name: 'main' }), stub)).toBe('b:main');
    expect(highlightKeyFor(ref({ name: 'v1', type: 'tag' }), null)).toBe('tag:v1');
    expect(highlightKeyFor(ref({ type: 'remoteBranch' }), null)).toBeNull();
    expect(highlightKeyFor(ref({ type: 'head', name: 'HEAD' }), null)).toBe('HEAD');
  });
});

describe('errors / reset', () => {
  it('explains known codes', () => {
    expect(explainErrorKey('dirtyWorktree')).toBe('ops.err.dirty');
    expect(explainErrorKey('wouldOverwrite')).toBe('ops.err.overwrite');
    expect(explainErrorKey('unmergedFiles')).toBe('ops.err.unmerged');
    expect(explainErrorKey('gitFailed')).toBeNull();
  });
  it('hard reset needs the typed word', () => {
    expect(resetConfirmWord(head())).toBe('main');
    expect(resetConfirmWord(head({ detached: true, branch: null }))).toBe('HEAD');
    expect(resetReady('soft', '', 'main')).toBe(true);
    expect(resetReady('hard', '', 'main')).toBe(false);
    expect(resetReady('hard', ' main ', 'main')).toBe(true);
  });
});

describe('push dialog state', () => {
  it('initial form', () => {
    expect(initPushForm(preview())).toEqual({ remote: 'origin', remoteBranch: 'main', setUpstream: false, followTags: false });
    expect(initPushForm(preview({ upstream: null, remote: null })).setUpstream).toBe(true);
  });
  it('canPush', () => {
    const p = preview();
    expect(canPush(p, initPushForm(p))).toBe(true);
    expect(canPush(preview({ outgoing: [] }), initPushForm(preview({ outgoing: [] })))).toBe(false);
    const np = preview({ outgoing: [], remoteHash: null });
    expect(canPush(np, initPushForm(np))).toBe(true);
    expect(canPush(p, { ...initPushForm(p), remote: '' })).toBe(false);
  });
  it('force only for the previewed remote branch, using remoteHash', () => {
    const p = preview();
    const f = initPushForm(p);
    expect(canForce(p, f)).toBe(true);
    expect(canForce(p, { ...f, remote: 'up' })).toBe(false);
    expect(canForce(p, { ...f, remoteBranch: 'other' })).toBe(false);
    expect(canForce(preview({ remoteHash: null }), f)).toBe(false);
    expect(buildPushRequest(p, f, false).forceWithLease).toBeNull();
    expect(buildPushRequest(p, f, true).forceWithLease).toBe(p.remoteHash);
    expect(buildPushRequest(p, { ...f, remote: 'up' }, true).forceWithLease).toBeNull();
    expect(buildPushRequest(p, { ...f, remoteBranch: ' x ' }, false)).toMatchObject({ remoteBranch: 'x', localBranch: 'main' });
  });
  it('classifies failures', () => {
    expect(pushFailureOf({ code: 'pushRejected', message: '', stderr: null })).toBe('rejected');
    expect(pushFailureOf({ code: 'staleLease', message: '', stderr: null })).toBe('stale');
    expect(pushFailureOf({ code: 'authFailed', message: '', stderr: null })).toBe('other');
  });
});
