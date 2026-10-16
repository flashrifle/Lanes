// src/types.ts — shared contract between src-tauri (Rust), src/graph, src/ui.
// Owned by orchestrator. Rust mirrors every interface with #[serde(rename_all = "camelCase")]
// and identical type names. Option<T> <-> T | null (always present, never omitted).
// Timestamps are unix SECONDS (i64 in Rust). Snapshot indices are u32.

// ───────────── Errors ─────────────
export type ErrorCode =
  | 'gitNotFound'      // no usable git binary
  | 'notARepo'         // path is not inside a work tree
  | 'gitFailed'        // generic non-zero exit
  | 'snapshotExpired'  // snapshotId evicted; UI must call load_log again
  | 'invalidArgument'  // bad ref name, bad regex, index out of range, deleting current branch...
  | 'notFullyMerged'   // `git branch -d` refused → UI offers force delete
  | 'nonFastForward'   // pull --ff-only refused → UI offers rebase/merge
  | 'noUpstream'       // pull with no tracking branch
  | 'wouldOverwrite'   // checkout would overwrite local changes
  | 'authFailed'       // fetch/pull credential failure
  | 'busy'             // another write op is running on this repo
  | 'io'
  | 'internal';

export interface AppError {
  code: ErrorCode;
  message: string;       // human-readable (English ok)
  stderr: string | null; // raw git stderr, if any
}

// ───────────── Repo ─────────────
export interface GitUser {
  name: string | null;   // git config user.name
  email: string | null;  // git config user.email
}

export interface RepoInfo {
  path: string;          // absolute work-tree root (rev-parse --show-toplevel); the repoPath key for all commands
  name: string;          // basename of path
  gitDir: string;        // absolute (rev-parse --absolute-git-dir)
  commonDir: string;     // absolute (rev-parse --git-common-dir), differs for linked worktrees
  user: GitUser;
  remotes: string[];     // `git remote`
  gitVersion: string;    // e.g. "2.50.1"
}

export interface RecentRepo {
  path: string;
  name: string;
  lastOpened: number;    // unix seconds
  exists: boolean;       // path still exists on disk
}

// ───────────── Refs ─────────────
export type RefType = 'head' | 'localBranch' | 'remoteBranch' | 'tag';

export interface Ref {
  name: string;            // short: "HEAD", "main", "origin/fix/login", "v1.2.0"
  fullName: string;        // "HEAD", "refs/heads/main", "refs/remotes/origin/fix/login", "refs/tags/v1.2.0"
  type: RefType;
  hash: string;            // commit hash (annotated tags peeled)
  index: number | null;    // snapshot index of `hash`; filled only in LogSnapshot.refs, null if not loaded
  remote: string | null;   // remoteBranch: "origin"; else null
  upstream: string | null; // localBranch: upstream fullName e.g. "refs/remotes/origin/main"
  ahead: number | null;    // localBranch with upstream
  behind: number | null;
  upstreamGone: boolean;   // upstream configured but missing
  isCurrent: boolean;      // localBranch checked out; also true for the 'head' ref
  isFavorite: boolean;     // persisted; default favorites = refs/heads/main, refs/heads/master
}

export interface HeadState {
  detached: boolean;
  unborn: boolean;            // repo has no commits yet
  branch: string | null;      // short name when on a branch
  fullName: string | null;    // "refs/heads/main"
  hash: string | null;        // null when unborn
}

export type RepoOperation = 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'bisect';

export interface RefsSnapshot {
  head: HeadState;
  refs: Ref[];                // includes one {type:'head', name:'HEAD'} entry when hash != null; excludes refs/remotes/*/HEAD, refs/stash
  operation: RepoOperation | null;
}

// Built by UI (src/ui/branches/branchTree.ts) from RefsSnapshot.
export type BranchGroupKind = 'head' | 'local' | 'remote' | 'remoteName' | 'folder' | 'tags';

export type BranchTreeNode =
  | {
      kind: 'group';
      id: string;              // stable path id, e.g. "remote/origin/fix"
      label: string;           // "로컬", "리모트", "origin", "fix", "태그"
      group: BranchGroupKind;
      children: BranchTreeNode[];
    }
  | {
      kind: 'ref';
      id: string;              // "ref:" + fullName
      label: string;           // leaf segment ("login" for origin/fix/login)
      ref: Ref;
    };

// ───────────── Log ─────────────
export interface LogScope {
  refs: string[] | null;   // fullNames (or "HEAD"); null = all: --branches --remotes --tags HEAD
  limit: number | null;    // max commits; null = unlimited
}

export interface LogSnapshot {
  snapshotId: number;
  repoPath: string;
  scope: LogScope;
  commitCount: number;
  hashes: string[];        // [index] → full hash; order = git --date-order (newest first, topo-valid)
  parents: number[][];     // [index] → parent snapshot indices in git parent order; -1 = parent not in snapshot
  timestamps: number[];    // [index] → committer time (unix s); used by Bek sort
  refs: RefsSnapshot;      // read just before git log; Ref.index filled
  headIndex: number | null;
  truncated: boolean;      // limit reached
  loadMillis: number;
}

export interface CommitMeta {
  index: number;           // snapshot index
  hash: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  authorTime: number;      // shown in Date column
  committerTime: number;
  parentCount: number;     // >1 → merge (rendered greyed)
}

export interface TextFilter {
  text: string;
  regex: boolean;          // Rust `regex` crate syntax (not JS)
  matchCase: boolean;
}

export interface DateRange {
  since: number | null;    // inclusive, unix s, compared to committerTime
  until: number | null;    // inclusive
}

export interface LogFilter {
  text: TextFilter | null;   // matches full message; plus hash prefix if text is 4..64 hex chars
  users: string[] | null;    // each: case-insensitive substring of "Name <email>"; OR-combined
  date: DateRange | null;
  paths: string[] | null;    // repo-relative; OR-combined
}

export interface FilterResult {
  matches: number[] | null;  // ascending snapshot indices; null = filter empty (everything visible)
}

export interface AuthorInfo {
  name: string;
  email: string;
  commitCount: number;       // result sorted by commitCount desc
}

// ───────────── Details / changes / diff ─────────────
export interface CommitDetails {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  committerName: string;
  committerEmail: string;
  committerTime: number;
  subject: string;
  body: string;              // message without subject line, trimmed
}

export type SignatureStatus =
  | 'good' | 'bad' | 'unknownValidity' | 'expired' | 'expiredKey' | 'revokedKey' | 'cannotCheck' | 'none';
  // from %G?: G, B, U, X, Y, R, E, N

export interface SignatureInfo {
  hash: string;
  status: SignatureStatus;
  signer: string | null;     // %GS
}

export type FileStatus =
  | 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typeChanged' | 'unmerged' | 'unknown';

export interface ChangedFile {
  path: string;              // new path (repo-relative)
  oldPath: string | null;    // renamed/copied only
  status: FileStatus;
  additions: number | null;  // null when binary or unknown
  deletions: number | null;
  binary: boolean;
  fromHash: string | null;   // diff base; null = empty tree (root commit)
  toHash: string;            // pass both straight into DiffRequest
}

export type ChangesMode =
  | 'single'   // one commit vs first parent (merges too)
  | 'range'    // selection is a linear first-parent chain: oldest^..newest
  | 'union';   // otherwise: union of per-commit changes; per path, newest commit wins

export interface ChangesResult {
  mode: ChangesMode;
  isMerge: boolean;          // single mode and commit has >1 parent
  files: ChangedFile[];      // sorted by path
}

export interface DiffRequest {
  path: string;
  oldPath: string | null;
  fromHash: string | null;
  toHash: string;
  contextLines: number | null; // default 3
}

export type DiffLineKind = 'context' | 'add' | 'del' | 'noNewline';

export interface DiffLine {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;              // without leading +/-/space, without trailing \n
}

export interface DiffHunk {
  header: string;            // full "@@ -a,b +c,d @@ fn" line
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath: string | null;
  binary: boolean;
  oldMode: string | null;
  newMode: string | null;
  hunks: DiffHunk[];
  truncated: boolean;        // diff exceeded 2 MB / 20k lines; hunks cut
}

// ───────────── Write ops ─────────────
export type CheckoutTarget =
  | { kind: 'localBranch'; name: string }                          // short name
  | { kind: 'remoteBranch'; name: string; localName: string | null } // "origin/fix/x"; localName default = part after remote
  | { kind: 'tag'; name: string }                                  // detached
  | { kind: 'commit'; hash: string };                              // detached

export type PullMode = 'ffOnly' | 'rebase' | 'merge';

export interface OpResult {
  message: string;           // trimmed git stdout+stderr summary for a toast
}

export interface BranchNameCheck {
  valid: boolean;
  exists: boolean;           // refs/heads/<name> already exists
  message: string | null;    // reason when invalid/exists
}

// ───────────── Events (backend → UI) ─────────────
export const EVENT_REPO_CHANGED = 'repo-changed';
export type RepoChangeScope = 'head' | 'refs' | 'fetchHead' | 'operation';
export interface RepoChangedEvent {
  repoPath: string;
  scopes: RepoChangeScope[];
}

export const EVENT_GIT_PROGRESS = 'git-progress';
export interface GitProgressEvent {
  repoPath: string;
  op: 'fetch' | 'pull' | 'checkout';
  line: string;              // one progress line (split on \r and \n)
}

// ───────────── Tauri command map (JS arg keys are camelCase) ─────────────
// [args, return]. Commands returning () resolve to null.
export interface CommandMap {
  open_repo: [{ path: string }, RepoInfo];
  close_repo: [{ repoPath: string }, null];
  get_recent_repos: [Record<string, never>, RecentRepo[]];
  remove_recent_repo: [{ path: string }, null];
  get_refs: [{ repoPath: string }, RefsSnapshot];
  set_favorite: [{ repoPath: string; fullName: string; favorite: boolean }, null];
  load_log: [{ repoPath: string; scope: LogScope }, LogSnapshot];
  release_snapshot: [{ snapshotId: number }, null];
  get_commit_rows: [{ snapshotId: number; indices: number[] }, CommitMeta[]];
  filter_commits: [{ snapshotId: number; filter: LogFilter }, FilterResult];
  get_authors: [{ snapshotId: number }, AuthorInfo[]];
  get_commit_details: [{ repoPath: string; hash: string }, CommitDetails];
  get_containing_refs: [{ repoPath: string; hash: string }, string[]];
  get_signatures: [{ repoPath: string; hashes: string[] }, SignatureInfo[]];
  get_changed_files: [{ repoPath: string; hashes: string[] }, ChangesResult];
  get_file_diff: [{ repoPath: string; request: DiffRequest }, FileDiff];
  validate_branch_name: [{ repoPath: string; name: string }, BranchNameCheck];
  checkout: [{ repoPath: string; target: CheckoutTarget }, OpResult];
  fetch: [{ repoPath: string; remote: string | null }, OpResult];
  pull: [{ repoPath: string; mode: PullMode }, OpResult];
  create_branch: [{ repoPath: string; name: string; startPoint: string; checkout: boolean }, OpResult];
  delete_branch: [{ repoPath: string; name: string; force: boolean }, OpResult];
}
export type CommandName = keyof CommandMap;

// ───────────── Graph engine contract (src/graph implements, src/ui consumes) ─────────────
export const GRAPH_COLOR_COUNT = 16; // colors are indices 0..15; UI owns the palette

export type GraphSortType = 'normal' | 'bek' | 'linearBek';

export interface GraphOptions {
  sortType: GraphSortType;
  visible: Uint8Array | null;  // length = commitCount, 1 = visible; null = all (from FilterResult.matches)
  collapseLongEdges: boolean;  // default true: edges spanning >= 30 rows show only ends + arrows
}

// Half-row edge segment, mirrors IntelliJ EdgePrintElement.
// Geometry (UI): x(l) = LANE_W*l + LANE_W/2, rowH = ROW_H.
//  dir 'down': line from (x(lane), rowH/2) to (x((lane+otherLane)/2), rowH)
//  dir 'up':   line from (x(lane), rowH/2) to (x((lane+otherLane)/2), 0)
// lane = position in THIS row, otherLane = position in the adjacent row (row+1 for down, row-1 for up).
// An edge passing through a row without touching its node yields one 'up' and one 'down' element.
export interface GraphEdgeElement {
  dir: 'up' | 'down';
  lane: number;
  otherLane: number;
  color: number;         // 0..GRAPH_COLOR_COUNT-1
  dotted: boolean;       // edge through filtered-out commits
}

// Arrowhead at (x(lane), rowH/2): long-edge truncation or not-loaded parent.
export interface GraphArrowElement {
  dir: 'up' | 'down';
  lane: number;
  color: number;
}

export interface GraphRow {
  commitIndex: number;   // snapshot index of the commit in this row
  nodeLane: number;
  nodeColor: number;
  laneCount: number;     // 1 + max lane used by any element in row; subject text offset = laneCount*LANE_W + pad
  edges: GraphEdgeElement[];
  arrows: GraphArrowElement[];
}

export interface GraphLayout {
  readonly rowCount: number;          // visible rows
  readonly maxLaneCount: number;
  getRow(row: number): GraphRow;      // lazy, cached; returned objects are immutable
  commitIndexAt(row: number): number;
  rowOf(commitIndex: number): number; // -1 if hidden
}

// Implemented in src/graph/index.ts:
//   export function buildGraph(snapshot: LogSnapshot, options: GraphOptions): GraphLayout;
