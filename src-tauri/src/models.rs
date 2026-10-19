//! Rust mirror of `src/types.ts`. Every struct serializes to exactly the TS shape.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitUser {
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub git_dir: String,
    pub common_dir: String,
    pub user: GitUser,
    pub remotes: Vec<String>,
    pub git_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentRepo {
    pub path: String,
    pub name: String,
    pub last_opened: i64,
    pub exists: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RefType {
    Head,
    LocalBranch,
    RemoteBranch,
    Tag,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ref {
    pub name: String,
    pub full_name: String,
    #[serde(rename = "type")]
    pub ref_type: RefType,
    pub hash: String,
    pub index: Option<u32>,
    pub remote: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub upstream_gone: bool,
    pub is_current: bool,
    pub is_favorite: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeadState {
    pub detached: bool,
    pub unborn: bool,
    pub branch: Option<String>,
    pub full_name: Option<String>,
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepoOperation {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Bisect,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefsSnapshot {
    pub head: HeadState,
    pub refs: Vec<Ref>,
    pub operation: Option<RepoOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogScope {
    pub refs: Option<Vec<String>>,
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogSnapshot {
    pub snapshot_id: u32,
    pub repo_path: String,
    pub scope: LogScope,
    pub commit_count: u32,
    pub hashes: Vec<String>,
    pub parents: Vec<Vec<i64>>,
    pub timestamps: Vec<i64>,
    pub refs: RefsSnapshot,
    pub head_index: Option<u32>,
    pub truncated: bool,
    pub load_millis: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitMeta {
    pub index: u32,
    pub hash: String,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer_time: i64,
    pub parent_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextFilter {
    pub text: String,
    pub regex: bool,
    pub match_case: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DateRange {
    pub since: Option<i64>,
    pub until: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogFilter {
    pub text: Option<TextFilter>,
    pub users: Option<Vec<String>>,
    pub date: Option<DateRange>,
    pub paths: Option<Vec<String>>,
    /// Branch compare; a missing field deserializes as `None`.
    #[serde(default)]
    pub rev_range: Option<RevRange>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FilterResult {
    pub matches: Option<Vec<u32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthorInfo {
    pub name: String,
    pub email: String,
    pub commit_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub committer_time: i64,
    pub subject: String,
    pub body: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SignatureStatus {
    Good,
    Bad,
    UnknownValidity,
    Expired,
    ExpiredKey,
    RevokedKey,
    CannotCheck,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignatureInfo {
    pub hash: String,
    pub status: SignatureStatus,
    pub signer: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Unmerged,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub binary: bool,
    pub from_hash: Option<String>,
    pub to_hash: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChangesMode {
    Single,
    Range,
    Union,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangesResult {
    pub mode: ChangesMode,
    pub is_merge: bool,
    pub files: Vec<ChangedFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffRequest {
    pub path: String,
    pub old_path: Option<String>,
    pub from_hash: Option<String>,
    pub to_hash: String,
    pub context_lines: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineKind {
    Context,
    Add,
    Del,
    NoNewline,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub binary: bool,
    pub old_mode: Option<String>,
    pub new_mode: Option<String>,
    pub hunks: Vec<DiffHunk>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CheckoutTarget {
    LocalBranch { name: String },
    RemoteBranch { name: String, local_name: Option<String> },
    Tag { name: String },
    Commit { hash: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PullMode {
    FfOnly,
    Rebase,
    Merge,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BranchNameCheck {
    pub valid: bool,
    pub exists: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum RepoChangeScope {
    Head,
    Refs,
    FetchHead,
    Operation,
    Index,
    Worktree,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoChangedEvent {
    pub repo_path: String,
    pub scopes: Vec<RepoChangeScope>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GitOp {
    Fetch,
    Pull,
    Checkout,
    Push,
    Commit,
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitProgressEvent {
    pub repo_path: String,
    pub op: GitOp,
    pub line: String,
}

pub const EVENT_REPO_CHANGED: &str = "repo-changed";
pub const EVENT_GIT_PROGRESS: &str = "git-progress";

// ───────────── File history / blame ─────────────
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub subject: String,
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileHistory {
    pub path: String,
    pub entries: Vec<FileHistoryEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    pub hash: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub subject: String,
    pub boundary: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub hash: String,
    pub orig_line: u32,
    pub orig_path: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlameResult {
    pub path: String,
    pub rev: String,
    pub lines: Vec<BlameLine>,
    pub commits: Vec<BlameCommit>,
    pub binary: bool,
    pub truncated: bool,
}

// ───────────── v0.1: working tree / staging ─────────────
pub const REV_INDEX: &str = "INDEX";
pub const REV_WORKTREE: &str = "WORKTREE";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    BothModified,
    BothAdded,
    BothDeleted,
    AddedByUs,
    AddedByThem,
    DeletedByUs,
    DeletedByThem,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusFile {
    pub path: String,
    pub old_path: Option<String>,
    pub staged: Option<FileStatus>,
    pub unstaged: Option<FileStatus>,
    pub untracked: bool,
    pub conflict: Option<ConflictKind>,
    pub submodule: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OperationState {
    pub operation: RepoOperation,
    pub head_name: Option<String>,
    pub onto_hash: Option<String>,
    pub stopped_at: Option<String>,
    pub step: Option<u32>,
    pub total: Option<u32>,
    pub can_continue: bool,
    pub can_skip: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkingTreeStatus {
    pub head_hash: Option<String>,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub files: Vec<StatusFile>,
    pub truncated: bool,
    pub operation: Option<OperationState>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PatchTarget {
    Index,
    Worktree,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPatchRequest {
    pub path: String,
    pub patch: String,
    pub target: PatchTarget,
    pub reverse: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscardRequest {
    pub paths: Vec<String>,
    pub untracked_paths: Vec<String>,
    pub include_staged: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictSide {
    Ours,
    Theirs,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    pub message: String,
    pub amend: bool,
    pub sign_off: bool,
    pub allow_empty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub hash: String,
    pub message: String,
}

// ───────────── Push ─────────────
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PushCommit {
    pub hash: String,
    pub subject: String,
    pub author_name: String,
    pub author_time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PushPreview {
    pub local_branch: String,
    pub remotes: Vec<String>,
    pub remote: Option<String>,
    pub remote_branch: String,
    pub upstream: Option<String>,
    pub remote_hash: Option<String>,
    pub outgoing: Vec<PushCommit>,
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    pub remote: String,
    pub local_branch: String,
    pub remote_branch: String,
    pub set_upstream: bool,
    pub force_with_lease: Option<String>,
    pub follow_tags: bool,
}

// ───────────── Stash ─────────────
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: u32,
    pub hash: String,
    pub message: String,
    pub branch: Option<String>,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StashRef {
    pub index: u32,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StashSaveRequest {
    pub message: Option<String>,
    pub include_untracked: bool,
    pub keep_index: bool,
    pub paths: Option<Vec<String>>,
}

// ───────────── Merge / rebase / sequence ─────────────
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MergeMode {
    Default,
    FfOnly,
    NoFf,
    Squash,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub mode: MergeMode,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpOutcome {
    pub message: String,
    pub conflicts: bool,
    pub operation: Option<RepoOperation>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OperationAction {
    Continue,
    Abort,
    Skip,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickRequest {
    pub hashes: Vec<String>,
    pub record_origin: bool,
    pub mainline: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RevertRequest {
    pub hashes: Vec<String>,
    pub mainline: Option<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResetRequest {
    pub hash: String,
    pub mode: ResetMode,
    pub discard_local_changes: bool,
}

// ───────────── Tags ─────────────
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateTagRequest {
    pub name: String,
    pub target: String,
    pub message: Option<String>,
}

pub type RefNameCheck = BranchNameCheck;

// ───────────── History exploration ─────────────
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RevRange {
    pub include: String,
    pub exclude: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CompareSummary {
    pub a_only: u32,
    pub b_only: u32,
    pub merge_base: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    pub selector: String,
    pub hash: String,
    pub action: String,
    pub message: String,
    pub time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reflog {
    #[serde(rename = "ref")]
    pub ref_name: String,
    pub entries: Vec<ReflogEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineHistoryEntry {
    pub hash: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub subject: String,
    pub path: String,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineHistory {
    pub path: String,
    pub rev: String,
    pub range: LineRange,
    pub entries: Vec<LineHistoryEntry>,
    pub truncated: bool,
}

// ───────────── App: settings / updates / diagnostics ─────────────
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LanguageSetting {
    System,
    Ko,
    En,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RowDensity {
    Comfortable,
    Compact,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DateFormatSetting {
    Relative,
    Absolute,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AppSettings {
    pub language: LanguageSetting,
    pub density: RowDensity,
    pub git_path: Option<String>,
    pub date_format: DateFormatSetting,
    pub external_editor: Option<String>,
    pub check_for_updates: bool,
    pub menu_bar_icon: bool,
    pub keep_running_in_menu_bar: bool,
    pub background_fetch_minutes: Option<u32>,
}

impl Default for AppSettings {
    fn default() -> Self {
        AppSettings {
            language: LanguageSetting::System,
            density: RowDensity::Comfortable,
            git_path: None,
            date_format: DateFormatSetting::Relative,
            external_editor: None,
            check_for_updates: true,
            menu_bar_icon: true,
            keep_running_in_menu_bar: true,
            background_fetch_minutes: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitPathCheck {
    pub ok: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub git_version: Option<String>,
    pub git_path: Option<String>,
    pub locale: Option<String>,
}

// ───────────── Menu bar / Quick Commit ─────────────
pub const QUICK_COMMIT_WINDOW_LABEL: &str = "quick-commit";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub path: String,
    pub name: String,
    pub open: bool,
    pub branch: Option<String>,
    pub head_hash: Option<String>,
    pub upstream: Option<String>,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub changed_count: u32,
    pub staged_count: u32,
    pub conflict_count: u32,
    pub operation: Option<RepoOperation>,
    pub last_fetch: Option<i64>,
    pub error: Option<String>,
}

// ───────────── Events ─────────────
pub const EVENT_SETTINGS_CHANGED: &str = "settings-changed";
pub const EVENT_UPDATE_PROGRESS: &str = "update-progress";
pub const EVENT_MENU_ACTION: &str = "menu-action";
pub const EVENT_REPO_SUMMARIES: &str = "repo-summaries";
pub const EVENT_QUICK_COMMIT_TARGET: &str = "quick-commit-target";
pub const EVENT_OPEN_REPO_REQUEST: &str = "open-repo-request";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressEvent {
    pub downloaded: u64,
    pub total: Option<u64>,
    pub finished: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MenuAction {
    Settings,
    CheckForUpdates,
    ReportIssue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MenuActionEvent {
    pub action: MenuAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommitTargetEvent {
    pub repo_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenRepoRequestEvent {
    pub path: String,
}
