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
  | 'invalidArgument'  // bad ref name, bad regex, index out of range, deleting current branch, stale stash ref...
  | 'notFullyMerged'   // `git branch -d` refused → UI offers force delete
  | 'nonFastForward'   // pull --ff-only refused → UI offers rebase/merge
  | 'noUpstream'       // pull with no tracking branch
  | 'wouldOverwrite'   // checkout/merge/stash apply would overwrite local changes
  | 'authFailed'       // fetch/pull/push credential failure
  | 'busy'             // another write op is running on this repo, or index.lock exists ("Unable to create '…index.lock'")
  | 'pushRejected'     // push "[rejected]" non-fast-forward / "fetch first" → UI offers pull, or force-with-lease (explicit)
  | 'staleLease'       // --force-with-lease refused ("stale info"): remote moved since the user looked
  | 'dirtyWorktree'    // rebase/cherry-pick/revert refused: "Please commit or stash them" / "You have unstaged changes"
  | 'nothingToCommit'  // "nothing to commit" / "no changes added to commit"
  | 'unmergedFiles'    // commit/continue with unresolved conflicts ("Committing is not possible because you have unmerged files")
  | 'patchFailed'      // git apply --check failed ("patch does not apply" / "corrupt patch"): diff is stale or not representable
  | 'updateFailed'     // updater check/download/install failed (message has details)
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
  revRange: RevRange | null; // branch compare: `git rev-list <include> ^<exclude>` ∩ snapshot (AND with the rest)
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

// Working-tree sentinels for DiffRequest / ChangedFile (REV_INDEX / REV_WORKTREE). Backend never passes them to git.
//  (headHash|null, REV_INDEX)    staged:   git diff --cached <head|emptytree> -- path
//  (REV_INDEX, REV_WORKTREE)     unstaged: git diff -- path
//  (headHash|null, REV_WORKTREE) combined: git diff <head|emptytree> -- path (conflicted files: shows markers)
//  (null, REV_WORKTREE) on an untracked path: git diff --no-index -- /dev/null path (exit 1 = ok)
export interface DiffRequest {
  path: string;
  oldPath: string | null;
  fromHash: string | null;   // full hash | REV_INDEX | null (= empty tree)
  toHash: string;            // full hash | REV_INDEX | REV_WORKTREE
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

// ───────────── File history / blame ─────────────
// One commit that touched the file, newest first. Follows renames (git log --follow), so `path` is the file's
// name at that commit. Diff for an entry: DiffRequest { path, oldPath, fromHash: parents[0] ?? null, toHash: hash }.
export interface FileHistoryEntry {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;        // unix seconds
  subject: string;
  path: string;              // path at this commit
  oldPath: string | null;    // previous path when this commit renamed/copied the file
  status: FileStatus;
  additions: number | null;  // null when binary or unknown
  deletions: number | null;
  binary: boolean;
}

export interface FileHistory {
  path: string;              // as requested
  entries: FileHistoryEntry[];
  truncated: boolean;        // capped at 5000 entries
}

export interface BlameCommit {
  hash: string;
  authorName: string;
  authorEmail: string;
  authorTime: number;
  subject: string;
  boundary: boolean;         // blame boundary (root / shallow limit)
}

export interface BlameLine {
  hash: string;              // key into BlameResult.commits
  origLine: number;          // 1-based line number in that commit's version
  origPath: string;          // file path in that commit (renames)
  text: string;              // without trailing \n
}

export interface BlameResult {
  path: string;
  rev: string;               // revision blamed, as requested
  lines: BlameLine[];        // index i = line i+1 of the file at `rev`
  commits: BlameCommit[];    // unique, in order of first appearance
  binary: boolean;           // binary file: lines empty
  truncated: boolean;        // capped at 50k lines
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

// ───────────── Working tree / staging ─────────────
export const REV_INDEX = 'INDEX';
export const REV_WORKTREE = 'WORKTREE';

export type ConflictKind =
  | 'bothModified' | 'bothAdded' | 'bothDeleted'   // UU AA DD
  | 'addedByUs' | 'addedByThem'                    // AU UA
  | 'deletedByUs' | 'deletedByThem';               // DU UD

// One path from `git status --porcelain=v2 -z --untracked-files=all` (records 1 / 2 / u / ?; ignored excluded).
export interface StatusFile {
  path: string;                    // repo-relative (new path for renames)
  oldPath: string | null;          // '2' records (staged rename/copy) only
  staged: FileStatus | null;       // X (index vs HEAD); null = unchanged
  unstaged: FileStatus | null;     // Y (worktree vs index); null = unchanged
  untracked: boolean;              // '?' record (staged/unstaged null)
  conflict: ConflictKind | null;   // 'u' record (staged/unstaged null)
  submodule: boolean;              // gitlink: file-level ops only
}

export interface OperationState {
  operation: RepoOperation;
  headName: string | null;         // rebase: branch being rebased (rebase-merge|rebase-apply/head-name, short)
  ontoHash: string | null;         // rebase: onto
  stoppedAt: string | null;        // commit being applied: REBASE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD / MERGE_HEAD[0]
  step: number | null;             // rebase msgnum / sequencer done count (1-based)
  total: number | null;            // rebase end / sequencer done+todo
  canContinue: boolean;            // no unmerged entries
  canSkip: boolean;                // rebase / cherryPick / revert
}

export interface WorkingTreeStatus {
  headHash: string | null;         // null when unborn
  branch: string | null;           // porcelain v2 "# branch.head"; null when detached / unborn
  upstream: string | null;         // fullName refs/remotes/<r>/<b>
  ahead: number | null;            // null without upstream
  behind: number | null;
  files: StatusFile[];             // sorted by path; "Uncommitted changes (N)" uses files.length
  truncated: boolean;              // capped at 10_000 entries
  operation: OperationState | null;
}

export type PatchTarget = 'index' | 'worktree';

// Line/hunk staging. UI (src/ui/commit/patch.ts) builds a single-file unified diff from a FileDiff + selected
// lines; backend validates and pipes it to `git apply --check` then `git apply [--cached] [--reverse] --recount
// --whitespace=nowarn -` (stdin). stage: unstaged diff, index, forward. unstage: staged diff, index, reverse.
// discard: unstaged diff, worktree, reverse. worktree && !reverse → invalidArgument.
export interface ApplyPatchRequest {
  path: string;              // the only path the patch may touch (backend checks the a/ and b/ header paths)
  patch: string;             // starts with "diff --git ", exactly one file, '\n' newlines, ends with '\n', <= 5 MB
  target: PatchTarget;
  reverse: boolean;
}

export interface DiscardRequest {
  paths: string[];           // tracked: git restore --worktree [--staged --source=HEAD] -- <paths>
  untrackedPaths: string[];  // verified untracked via ls-files --others, then git clean -f -q -- <paths> (never -d/-x)
  includeStaged: boolean;    // true = also reset index to HEAD (IntelliJ "Rollback"); false = worktree from index
}

export type ConflictSide = 'ours' | 'theirs';  // NB: during rebase "ours" = upstream/onto; UI labels accordingly

export interface CommitRequest {
  message: string;           // full message via stdin (git commit -F -), never argv; empty/whitespace → invalidArgument
  amend: boolean;            // --amend; unborn → invalidArgument
  signOff: boolean;          // --signoff
  allowEmpty: boolean;       // --allow-empty (never implied)
}

export interface CommitResult {
  hash: string;              // new HEAD
  message: string;           // summary for toast
}

// ───────────── Push ─────────────
export interface PushCommit {
  hash: string;
  subject: string;
  authorName: string;
  authorTime: number;
}

export interface PushPreview {
  localBranch: string;             // short
  remotes: string[];
  remote: string | null;           // upstream remote, else "origin" if present, else first, else null
  remoteBranch: string;            // upstream branch short name, else localBranch
  upstream: string | null;         // fullName, null = none (UI defaults setUpstream = true)
  remoteHash: string | null;       // current refs/remotes/<remote>/<remoteBranch>; null = branch absent on remote
  outgoing: PushCommit[];          // upstream..HEAD (or HEAD --not --remotes), newest first, capped 500
  behind: number;                  // HEAD..upstream count (UI warns: push will be rejected)
}

export interface PushRequest {
  remote: string;
  localBranch: string;             // pushes refs/heads/<localBranch>:refs/heads/<remoteBranch>
  remoteBranch: string;
  setUpstream: boolean;            // -u
  forceWithLease: string | null;   // null = never force; full hash = --force-with-lease=refs/heads/<rb>:<hash> (PushPreview.remoteHash)
  followTags: boolean;             // --follow-tags
}

// ───────────── Stash ─────────────
export interface StashEntry {
  index: number;                   // n in stash@{n}
  hash: string;
  message: string;                 // %gs, e.g. "WIP on main: abc123 subject" / "On main: msg"
  branch: string | null;           // parsed from message
  time: number;                    // unix s
}

export interface StashRef {
  index: number;
  hash: string;                    // backend verifies `rev-parse stash@{index}` == hash, else invalidArgument
}

export interface StashSaveRequest {
  message: string | null;          // -m
  includeUntracked: boolean;       // -u (never -a)
  keepIndex: boolean;              // -k
  paths: string[] | null;          // git stash push -- <paths>; null = everything
}

// ───────────── Merge / rebase / sequence ─────────────
export type MergeMode = 'default' | 'ffOnly' | 'noFf' | 'squash';

export interface MergeRequest {
  ref: string;                     // fullName or full hash (merged INTO current branch)
  mode: MergeMode;
  message: string | null;          // -m; null = git default (--no-edit)
}

// Ops that may stop half-way. Conflicts are an outcome, not an error: decided by unmerged entries
// (`diff --name-only --diff-filter=U`) after the command, not by stderr text.
export interface OpOutcome {
  message: string;
  conflicts: boolean;
  operation: RepoOperation | null; // in progress after the command
}

export type OperationAction = 'continue' | 'abort' | 'skip';

export interface CherryPickRequest {
  hashes: string[];                // application order: OLDEST first
  recordOrigin: boolean;           // -x
  mainline: number | null;         // -m <n>; required (else invalidArgument) when any commit is a merge
}

export interface RevertRequest {
  hashes: string[];                // application order: NEWEST first; always --no-edit
  mainline: number | null;
}

export type ResetMode = 'soft' | 'mixed' | 'hard';

export interface ResetRequest {
  hash: string;                    // full hash; current branch (or detached HEAD) moves here
  mode: ResetMode;
  discardLocalChanges: boolean;    // MUST be true for 'hard', else invalidArgument
}

// ───────────── Tags ─────────────
export interface CreateTagRequest {
  name: string;                    // validated: check-ref-format refs/tags/<name>; existing → invalidArgument (no -f)
  target: string;                  // full hash
  message: string | null;          // non-null → annotated (git tag -a -F - via stdin); null → lightweight
}

export type RefNameCheck = BranchNameCheck;

// ───────────── History exploration ─────────────
export interface RevRange {
  include: string;                 // fullName or full hash (not starting with '-')
  exclude: string;
}

export interface CompareSummary {
  aOnly: number;                   // rev-list --left-right --count a...b (left)
  bOnly: number;                   // (right)
  mergeBase: string | null;
}

export interface ReflogEntry {
  selector: string;                // "HEAD@{3}" (position-based)
  hash: string;
  action: string;                  // text before the first ": " of %gs, e.g. "checkout", "commit (amend)", "rebase (finish)"
  message: string;                 // rest of %gs
  time: number;                    // reflog entry time (unix s)
}

export interface Reflog {
  ref: string;                     // "HEAD" or refs/heads/<x>
  entries: ReflogEntry[];          // newest first
  truncated: boolean;
}

export interface LineRange {
  start: number;                   // 1-based inclusive, in the file at `rev`
  end: number;
}

export interface LineHistoryEntry {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTime: number;
  subject: string;
  path: string;                    // file path at this commit (from +++ b/…)
  hunks: DiffHunk[];               // the range's diff in this commit
}

export interface LineHistory {
  path: string;
  rev: string;                     // resolved full hash
  range: LineRange;
  entries: LineHistoryEntry[];     // newest first; git log -L<start>,<end>:<path> <rev>
  truncated: boolean;              // capped at 500 commits / 8 MB / 60 s
}

// ───────────── App: settings / updates / diagnostics ─────────────
export type LanguageSetting = 'system' | 'ko' | 'en';
export type RowDensity = 'comfortable' | 'compact';
export type DateFormatSetting = 'relative' | 'absolute';

export interface AppSettings {
  language: LanguageSetting;
  density: RowDensity;
  gitPath: string | null;          // null = auto-detect (GIT_LOG_VIEWER_GIT, homebrew, /usr/local, /usr/bin, PATH)
  dateFormat: DateFormatSetting;
  externalEditor: string | null;   // macOS app name or .app path for "Open in Editor"; null = system default app
  checkForUpdates: boolean;        // check on launch (default true)
  menuBarIcon: boolean;            // default true: tray icon
  keepRunningInMenuBar: boolean;   // default true; requires menuBarIcon. Closing main hides it + Accessory activation policy
  backgroundFetchMinutes: number | null; // default null = off; allowed 15 | 30 | 60 (else invalidArgument)
}

export interface GitPathCheck {
  ok: boolean;
  path: string | null;             // resolved absolute path
  version: string | null;          // "2.50.1"
  message: string | null;          // reason when !ok, or "git >= 2.23 required" warning
}

export interface UpdateInfo {
  version: string;                 // available
  currentVersion: string;
  notes: string | null;
  pubDate: string | null;          // RFC 3339
}

export interface Diagnostics {
  appVersion: string;
  os: string;                      // "macOS 15.1" (sw_vers -productVersion)
  arch: string;                    // "aarch64" | "x86_64"
  gitVersion: string | null;
  gitPath: string | null;
  locale: string | null;
}

// ───────────── Menu bar / Quick Commit ─────────────
export const QUICK_COMMIT_WINDOW_LABEL = 'quick-commit'; // index.html?quickCommit=1

// Derived in Rust from status::read (never a separate walk).
export interface RepoSummary {
  path: string;
  name: string;
  open: boolean;                   // has a tab in the main window
  branch: string | null;           // null when detached / unborn
  headHash: string | null;
  upstream: string | null;         // fullName
  ahead: number | null;            // null without upstream
  behind: number | null;
  changedCount: number;            // status entries
  stagedCount: number;
  conflictCount: number;
  operation: RepoOperation | null;
  lastFetch: number | null;        // FETCH_HEAD mtime, unix s
  error: string | null;            // status failed (e.g. folder gone)
}

// ───────────── Events (backend → UI) ─────────────
export const EVENT_REPO_CHANGED = 'repo-changed';
export type RepoChangeScope =
  | 'head' | 'refs' | 'fetchHead' | 'operation'
  | 'index'     // .git/index rewritten (stage/unstage/commit/checkout); UI: refresh status only
  | 'worktree'; // file under the work tree changed (outside gitDir); 1000 ms debounce; UI: refresh status only
export interface RepoChangedEvent {
  repoPath: string;
  scopes: RepoChangeScope[];
}

export const EVENT_GIT_PROGRESS = 'git-progress';
export interface GitProgressEvent {
  repoPath: string;
  op: 'fetch' | 'pull' | 'checkout' | 'push' | 'commit' | 'merge' | 'rebase' | 'cherryPick' | 'revert';
  line: string;              // one progress / hook output line (split on \r and \n)
}

export const EVENT_SETTINGS_CHANGED = 'settings-changed';   // payload: AppSettings, to all windows

export const EVENT_UPDATE_PROGRESS = 'update-progress';
export interface UpdateProgressEvent {
  downloaded: number;              // bytes so far
  total: number | null;
  finished: boolean;
}

export const EVENT_MENU_ACTION = 'menu-action';             // to the "main" window only (Rust shows/focuses it first)
export type MenuAction = 'settings' | 'checkForUpdates' | 'reportIssue'; // native menu and tray emit the same
export interface MenuActionEvent {
  action: MenuAction;
}

export const EVENT_REPO_SUMMARIES = 'repo-summaries';       // payload: RepoSummary[], debounced 1 s, all windows

export const EVENT_QUICK_COMMIT_TARGET = 'quick-commit-target'; // to "quick-commit" each time it is shown
export interface QuickCommitTargetEvent {
  repoPath: string;
}

export const EVENT_OPEN_REPO_REQUEST = 'open-repo-request'; // to "main": open/focus this repo as a tab
export interface OpenRepoRequestEvent {
  path: string;
}

// ───────────── Tauri command map (JS arg keys are camelCase) ─────────────
// [args, return]. Commands returning () resolve to null.
export interface CommandMap {
  open_repo: [{ path: string }, RepoInfo];
  close_repo: [{ repoPath: string }, null];
  get_recent_repos: [Record<string, never>, RecentRepo[]];
  /** System UI locale (BCP-47, e.g. "ko-KR"), or null when unknown. Same source as the native menu language. */
  get_system_locale: [Record<string, never>, string | null];
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
  /** git log --follow for one file; rev null = HEAD. */
  get_file_history: [{ repoPath: string; path: string; rev: string | null }, FileHistory];
  /** git blame --porcelain <rev> -- <path>. */
  get_blame: [{ repoPath: string; path: string; rev: string }, BlameResult];
  /** Tracked file paths at rev (null = HEAD), sorted; for the file picker. */
  list_files: [{ repoPath: string; rev: string | null }, string[]];
  validate_branch_name: [{ repoPath: string; name: string }, BranchNameCheck];
  checkout: [{ repoPath: string; target: CheckoutTarget }, OpResult];
  fetch: [{ repoPath: string; remote: string | null }, OpResult];
  pull: [{ repoPath: string; mode: PullMode }, OpResult];
  create_branch: [{ repoPath: string; name: string; startPoint: string; checkout: boolean }, OpResult];
  delete_branch: [{ repoPath: string; name: string; force: boolean }, OpResult];
  // ── working tree / staging (all writes: RepoLocks, 60 s; --literal-pathspecs; paths checked: non-empty, no NUL, inside repo) ──
  /** Read-only (GIT_OPTIONAL_LOCKS=0). porcelain v2 -z + operation state. */
  get_status: [{ repoPath: string }, WorkingTreeStatus];
  /** git add -A -- <paths>. Also "mark resolved". */
  stage_files: [{ repoPath: string; paths: string[] }, OpResult];
  /** git restore --staged -- <paths>; unborn HEAD: git rm --cached -r -q -- <paths>. */
  unstage_files: [{ repoPath: string; paths: string[] }, OpResult];
  /** Destructive; UI confirms first. */
  discard_files: [{ repoPath: string; request: DiscardRequest }, OpResult];
  /** Line/hunk stage / unstage / discard. patchFailed when the diff is stale. */
  apply_patch: [{ repoPath: string; request: ApplyPatchRequest }, OpResult];
  /** git commit -F - [--amend] [--signoff] [--allow-empty]; hooks run; 300 s; progress op 'commit'. */
  commit: [{ repoPath: string; request: CommitRequest }, CommitResult];
  /** git checkout --ours|--theirs -- <paths>, then git add -A -- <paths>. */
  resolve_conflict: [{ repoPath: string; paths: string[]; side: ConflictSide }, OpResult];
  /** Opens <repo>/<path> with AppSettings.externalEditor or the default app; path must canonicalize inside the repo. */
  open_in_editor: [{ repoPath: string; path: string }, null];
  reveal_in_finder: [{ repoPath: string; path: string }, null];
  // ── push ──
  /** localBranch null = current branch (detached/unborn → invalidArgument). */
  get_push_preview: [{ repoPath: string; localBranch: string | null }, PushPreview];
  /** git push --progress --porcelain [-u] [--follow-tags] [--force-with-lease=<ref>:<hash>] <remote> <src>:<dst>; 300 s. Never --force. */
  push: [{ repoPath: string; request: PushRequest }, OpResult];
  // ── stash ──
  list_stashes: [{ repoPath: string }, StashEntry[]];
  stash_save: [{ repoPath: string; request: StashSaveRequest }, OpResult];
  /** git stash apply|pop [--index] stash@{n}; conflicts → OpOutcome.conflicts (pop keeps the entry). */
  stash_apply: [{ repoPath: string; stash: StashRef; pop: boolean; restoreIndex: boolean }, OpOutcome];
  stash_drop: [{ repoPath: string; stash: StashRef }, OpResult];
  // ── merge / rebase / cherry-pick / revert / reset (300 s: hooks) ──
  merge: [{ repoPath: string; request: MergeRequest }, OpOutcome];
  /** Non-interactive `git rebase <onto>` of the current branch. Never --autostash, never -i. */
  rebase: [{ repoPath: string; onto: string }, OpOutcome];
  /** git <op> --continue|--abort|--skip; `operation` must equal the detected in-progress op (else invalidArgument); bisect unsupported. */
  control_operation: [{ repoPath: string; operation: RepoOperation; action: OperationAction }, OpOutcome];
  cherry_pick: [{ repoPath: string; request: CherryPickRequest }, OpOutcome];
  revert: [{ repoPath: string; request: RevertRequest }, OpOutcome];
  reset: [{ repoPath: string; request: ResetRequest }, OpResult];
  // ── tags ──
  validate_tag_name: [{ repoPath: string; name: string }, RefNameCheck];
  create_tag: [{ repoPath: string; request: CreateTagRequest }, OpResult];
  /** git tag -d <name> (local only). */
  delete_tag: [{ repoPath: string; name: string }, OpResult];
  /** git push --progress <remote> refs/tags/<name>:refs/tags/<name>; progress op 'push'. */
  push_tag: [{ repoPath: string; remote: string; name: string }, OpResult];
  // ── history exploration (read-only) ──
  /** ref null = HEAD; only HEAD or refs/heads/*; limit null = 1000. */
  get_reflog: [{ repoPath: string; ref: string | null; limit: number | null }, Reflog];
  compare_refs: [{ repoPath: string; a: string; b: string }, CompareSummary];
  /** git log -L<start>,<end>:<path> <rev|HEAD>; rev null = HEAD. */
  get_line_history: [{ repoPath: string; path: string; rev: string | null; range: LineRange }, LineHistory];
  // ── app ──
  get_settings: [Record<string, never>, AppSettings];
  /** Persists to state.json, applies gitPath (validate first) + menu language + tray, emits settings-changed. Returns the stored value. */
  set_settings: [{ settings: AppSettings }, AppSettings];
  /** path null = what auto-detect would pick. */
  validate_git_path: [{ path: string | null }, GitPathCheck];
  get_diagnostics: [Record<string, never>, Diagnostics];
  /** null = up to date. Keeps the pending Update in AppState for install_update. */
  check_for_update: [Record<string, never>, UpdateInfo | null];
  /** Downloads + installs the update found by the last check (invalidArgument if none); emits update-progress. */
  install_update: [Record<string, never>, null];
  /** AppHandle::restart(). */
  restart_app: [Record<string, never>, null];
  // ── menu bar (tray) ──
  /** Open repos first (by name), then existing recents; max 8; recents cached <= 60 s. */
  get_repo_summaries: [Record<string, never>, RepoSummary[]];
  /** Shows/positions the quick-commit window under the tray icon and emits quick-commit-target. */
  open_quick_commit: [{ repoPath: string }, null];
  /** Regular activation policy + show/focus main; non-null repoPath also emits open-repo-request. */
  show_main_window: [{ repoPath: string | null }, null];
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
// Every element carries its branch-line id (LineColors owner id). Highlight = UI dims elements whose
// line != highlighted line; no relayout. Ids are per-layout; persist highlight as lineKey().
export interface GraphEdgeElement {
  dir: 'up' | 'down';
  lane: number;
  otherLane: number;
  color: number;         // 0..GRAPH_COLOR_COUNT-1
  dotted: boolean;       // edge through filtered-out commits
  line: number;          // first-parent edge → child's line; merge edge → merged parent's line (same rule as edgeColor)
}

// Arrowhead at (x(lane), rowH/2): long-edge truncation or not-loaded parent.
export interface GraphArrowElement {
  dir: 'up' | 'down';
  lane: number;
  color: number;
  line: number;
}

export interface GraphRow {
  commitIndex: number;   // snapshot index of the commit in this row
  nodeLane: number;
  nodeColor: number;
  nodeLine: number;      // line owning this commit
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
  lineOf(commitIndex: number): number;  // -1 if out of range
  lineKey(line: number): string;        // stable across reloads: "b:main", "tag:v1", "HEAD", "merge:<hash>[#k]", "tip:<hash>"
  lineOfKey(key: string): number;       // -1 if absent
  /** Ref's own named line if it owns >= 1 commit, else the line owning the ref's commit; -1 if not loaded. */
  lineOfRef(fullName: string): number;
}

// Implemented in src/graph/index.ts:
//   export function buildGraph(snapshot: LogSnapshot, options: GraphOptions): GraphLayout;
