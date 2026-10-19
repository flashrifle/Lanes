/// <reference types="node" />
// Verifies Rust serde output (src-tauri/tests/fixtures/contract/*.json, written by `cargo test`)
// has exactly the keys declared in src/types.ts. `Keys<T>` makes tsc reject missing/extra keys here.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type * as T from './types';

type Keys<X> = Record<keyof X, true>;
const k = <X>(o: Keys<X>) => Object.keys(o).sort();

const expected: Record<string, string[]> = {
  AppError: k<T.AppError>({ code: true, message: true, stderr: true }),
  AuthorInfo: k<T.AuthorInfo>({ name: true, email: true, commitCount: true }),
  BlameCommit: k<T.BlameCommit>({ hash: true, authorName: true, authorEmail: true, authorTime: true, subject: true, boundary: true }),
  BlameLine: k<T.BlameLine>({ hash: true, origLine: true, origPath: true, text: true }),
  BlameResult: k<T.BlameResult>({ path: true, rev: true, lines: true, commits: true, binary: true, truncated: true }),
  BranchNameCheck: k<T.BranchNameCheck>({ valid: true, exists: true, message: true }),
  ChangedFile: k<T.ChangedFile>({ path: true, oldPath: true, status: true, additions: true, deletions: true, binary: true, fromHash: true, toHash: true }),
  ChangesResult: k<T.ChangesResult>({ mode: true, isMerge: true, files: true }),
  CheckoutTarget: k<Extract<T.CheckoutTarget, { kind: 'remoteBranch' }>>({ kind: true, name: true, localName: true }),
  CommitDetails: k<T.CommitDetails>({ hash: true, parents: true, authorName: true, authorEmail: true, authorTime: true, committerName: true, committerEmail: true, committerTime: true, subject: true, body: true }),
  CommitMeta: k<T.CommitMeta>({ index: true, hash: true, subject: true, authorName: true, authorEmail: true, authorTime: true, committerTime: true, parentCount: true }),
  DateRange: k<T.DateRange>({ since: true, until: true }),
  DiffHunk: k<T.DiffHunk>({ header: true, oldStart: true, oldLines: true, newStart: true, newLines: true, lines: true }),
  DiffLine: k<T.DiffLine>({ kind: true, oldLine: true, newLine: true, text: true }),
  DiffRequest: k<T.DiffRequest>({ path: true, oldPath: true, fromHash: true, toHash: true, contextLines: true }),
  FileDiff: k<T.FileDiff>({ path: true, oldPath: true, binary: true, oldMode: true, newMode: true, hunks: true, truncated: true }),
  FileHistory: k<T.FileHistory>({ path: true, entries: true, truncated: true }),
  FileHistoryEntry: k<T.FileHistoryEntry>({ hash: true, parents: true, authorName: true, authorEmail: true, authorTime: true, subject: true, path: true, oldPath: true, status: true, additions: true, deletions: true, binary: true }),
  FilterResult: k<T.FilterResult>({ matches: true }),
  GitProgressEvent: k<T.GitProgressEvent>({ repoPath: true, op: true, line: true }),
  GitUser: k<T.GitUser>({ name: true, email: true }),
  HeadState: k<T.HeadState>({ detached: true, unborn: true, branch: true, fullName: true, hash: true }),
  LogFilter: k<T.LogFilter>({ text: true, users: true, date: true, paths: true }),
  LogScope: k<T.LogScope>({ refs: true, limit: true }),
  LogSnapshot: k<T.LogSnapshot>({ snapshotId: true, repoPath: true, scope: true, commitCount: true, hashes: true, parents: true, timestamps: true, refs: true, headIndex: true, truncated: true, loadMillis: true }),
  OpResult: k<T.OpResult>({ message: true }),
  RecentRepo: k<T.RecentRepo>({ path: true, name: true, lastOpened: true, exists: true }),
  Ref: k<T.Ref>({ name: true, fullName: true, type: true, hash: true, index: true, remote: true, upstream: true, ahead: true, behind: true, upstreamGone: true, isCurrent: true, isFavorite: true }),
  RefsSnapshot: k<T.RefsSnapshot>({ head: true, refs: true, operation: true }),
  RepoChangedEvent: k<T.RepoChangedEvent>({ repoPath: true, scopes: true }),
  RepoInfo: k<T.RepoInfo>({ path: true, name: true, gitDir: true, commonDir: true, user: true, remotes: true, gitVersion: true }),
  SignatureInfo: k<T.SignatureInfo>({ hash: true, status: true, signer: true }),
  TextFilter: k<T.TextFilter>({ text: true, regex: true, matchCase: true }),
};

const dir = new URL('../src-tauri/tests/fixtures/contract/', import.meta.url);
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.json'));

describe('Rust ↔ TS contract', () => {
  it('has a fixture for every contract type', () => {
    expect(fixtures.map((f) => f.replace('.json', '')).sort()).toEqual(Object.keys(expected).sort());
  });
  for (const f of fixtures) {
    const name = f.replace('.json', '');
    it(`${name} keys match types.ts`, () => {
      const json = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      expect(Object.keys(json).sort()).toEqual(expected[name]);
    });
  }
});
