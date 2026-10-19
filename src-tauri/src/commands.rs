use crate::error::{AppError, Result};
use crate::app::{self, settings as app_settings};
use crate::git::{changes, commit, diff, file, linehist, log, ops, push, reflog, refs, sequence, stage, stash, status, tags};
use crate::tray;
use crate::models::*;
use crate::snapshot;
use crate::state::AppState;
use crate::watcher::Emitter;
use std::sync::Arc;
use tauri::{AppHandle, Emitter as _, State};

async fn blocking<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::internal(format!("task failed: {e}")))?
}

fn progress_cb<'a>(app: &'a AppHandle, repo: &'a str, op: GitOp) -> impl FnMut(&str) + 'a {
    move |line: &str| {
        let _ = app.emit(
            EVENT_GIT_PROGRESS,
            GitProgressEvent { repo_path: repo.to_string(), op, line: line.to_string() },
        );
    }
}

#[tauri::command]
pub async fn open_repo(state: State<'_, AppState>, app: AppHandle, path: String) -> Result<RepoInfo> {
    let s = state.inner().clone();
    let app2 = app.clone();
    let emit: Emitter = Arc::new(move |ev| {
        let _ = app.emit(EVENT_REPO_CHANGED, ev);
        tray::poke(&app);
    });
    let r = blocking(move || s.open_repo(&path, emit)).await;
    tray::poke(&app2);
    r
}

#[tauri::command]
pub async fn close_repo(state: State<'_, AppState>, app: AppHandle, repo_path: String) -> Result<()> {
    let s = state.inner().clone();
    let r = blocking(move || {
        s.close_repo(&repo_path);
        Ok(())
    })
    .await;
    tray::poke(&app);
    r
}

#[tauri::command]
pub async fn get_recent_repos(state: State<'_, AppState>) -> Result<Vec<RecentRepo>> {
    let s = state.inner().clone();
    blocking(move || Ok(s.persist.recents())).await
}

#[tauri::command]
pub async fn remove_recent_repo(state: State<'_, AppState>, path: String) -> Result<()> {
    let s = state.inner().clone();
    blocking(move || {
        s.persist.remove_recent(&path);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn get_refs(state: State<'_, AppState>, repo_path: String) -> Result<RefsSnapshot> {
    let s = state.inner().clone();
    blocking(move || refs::read_refs(&repo_path, &s.persist.favorites(&repo_path))).await
}

#[tauri::command]
pub async fn set_favorite(state: State<'_, AppState>, repo_path: String, full_name: String, favorite: bool) -> Result<()> {
    let s = state.inner().clone();
    blocking(move || {
        s.persist.set_favorite(&repo_path, &full_name, favorite);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn load_log(state: State<'_, AppState>, repo_path: String, scope: LogScope) -> Result<LogSnapshot> {
    let s = state.inner().clone();
    blocking(move || snapshot::load_log(&s.snapshots, &repo_path, scope, &s.persist.favorites(&repo_path))).await
}

#[tauri::command]
pub async fn release_snapshot(state: State<'_, AppState>, snapshot_id: u32) -> Result<()> {
    state.snapshots.release(snapshot_id);
    Ok(())
}

#[tauri::command]
pub async fn get_commit_rows(state: State<'_, AppState>, snapshot_id: u32, indices: Vec<u32>) -> Result<Vec<CommitMeta>> {
    let s = state.inner().clone();
    blocking(move || {
        let snap = s.snapshots.get(snapshot_id)?;
        snapshot::commit_rows(&snap, &indices)
    })
    .await
}

#[tauri::command]
pub async fn filter_commits(state: State<'_, AppState>, snapshot_id: u32, filter: LogFilter) -> Result<FilterResult> {
    let s = state.inner().clone();
    blocking(move || {
        let snap = s.snapshots.get(snapshot_id)?;
        snapshot::filter_commits(&snap, &filter)
    })
    .await
}

#[tauri::command]
pub async fn get_authors(state: State<'_, AppState>, snapshot_id: u32) -> Result<Vec<AuthorInfo>> {
    let s = state.inner().clone();
    blocking(move || {
        let snap = s.snapshots.get(snapshot_id)?;
        Ok(snapshot::authors(&snap))
    })
    .await
}

#[tauri::command]
pub async fn get_commit_details(repo_path: String, hash: String) -> Result<CommitDetails> {
    blocking(move || log::commit_details(&repo_path, &hash)).await
}

#[tauri::command]
pub async fn get_containing_refs(repo_path: String, hash: String) -> Result<Vec<String>> {
    blocking(move || refs::containing_refs(&repo_path, &hash)).await
}

#[tauri::command]
pub async fn get_signatures(repo_path: String, hashes: Vec<String>) -> Result<Vec<SignatureInfo>> {
    blocking(move || log::signatures(&repo_path, &hashes)).await
}

#[tauri::command]
pub async fn get_changed_files(repo_path: String, hashes: Vec<String>) -> Result<ChangesResult> {
    blocking(move || changes::changed_files(&repo_path, &hashes)).await
}

#[tauri::command]
pub async fn get_file_diff(repo_path: String, request: DiffRequest) -> Result<FileDiff> {
    blocking(move || diff::file_diff(&repo_path, &request)).await
}

#[tauri::command]
pub async fn get_file_history(repo_path: String, path: String, rev: Option<String>) -> Result<FileHistory> {
    blocking(move || file::file_history(&repo_path, &path, rev.as_deref())).await
}

#[tauri::command]
pub async fn get_blame(repo_path: String, path: String, rev: String) -> Result<BlameResult> {
    blocking(move || file::blame(&repo_path, &path, &rev)).await
}

#[tauri::command]
pub async fn list_files(repo_path: String, rev: Option<String>) -> Result<Vec<String>> {
    blocking(move || file::list_files(&repo_path, rev.as_deref())).await
}

#[tauri::command]
pub fn get_system_locale() -> Option<String> {
    sys_locale::get_locale()
}

#[tauri::command]
pub async fn validate_branch_name(repo_path: String, name: String) -> Result<BranchNameCheck> {
    blocking(move || ops::validate_branch_name(&repo_path, &name)).await
}

#[tauri::command]
pub async fn checkout(state: State<'_, AppState>, app: AppHandle, repo_path: String, target: CheckoutTarget) -> Result<OpResult> {
    let s = state.inner().clone();
    blocking(move || {
        let mut cb = progress_cb(&app, &repo_path, GitOp::Checkout);
        ops::checkout(&s.locks, &repo_path, &target, &mut cb)
    })
    .await
}

#[tauri::command]
pub async fn fetch(state: State<'_, AppState>, app: AppHandle, repo_path: String, remote: Option<String>) -> Result<OpResult> {
    let s = state.inner().clone();
    blocking(move || {
        let mut cb = progress_cb(&app, &repo_path, GitOp::Fetch);
        ops::fetch(&s.locks, &repo_path, remote.as_deref(), &mut cb)
    })
    .await
}

#[tauri::command]
pub async fn pull(state: State<'_, AppState>, app: AppHandle, repo_path: String, mode: PullMode) -> Result<OpResult> {
    let s = state.inner().clone();
    blocking(move || {
        let mut cb = progress_cb(&app, &repo_path, GitOp::Pull);
        ops::pull(&s.locks, &repo_path, mode, &mut cb)
    })
    .await
}

#[tauri::command]
pub async fn create_branch(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
    start_point: String,
    checkout: bool,
) -> Result<OpResult> {
    let s = state.inner().clone();
    blocking(move || ops::create_branch(&s.locks, &repo_path, &name, &start_point, checkout)).await
}

#[tauri::command]
pub async fn delete_branch(state: State<'_, AppState>, repo_path: String, name: String, force: bool) -> Result<OpResult> {
    let s = state.inner().clone();
    blocking(move || ops::delete_branch(&s.locks, &repo_path, &name, force)).await
}

// ───────────── working tree / staging ─────────────
#[tauri::command]
pub async fn get_status(repo_path: String) -> Result<WorkingTreeStatus> {
    blocking(move || status::read(&repo_path)).await
}

#[tauri::command]
pub async fn stage_files(state: State<'_, AppState>, repo_path: String, paths: Vec<String>) -> Result<OpResult> {
    let s = state.inner().clone();
    blocking(move || stage::stage_files(&s.locks, &repo_path, &paths)).await
}

#[tauri::command]
pub async fn unstage_files(state: State<'_, AppState>, repo_path: String, paths: Vec<String>) -> Result<OpResult> {
    let s = state.inner().clone();
    blocking(move || stage::unstage_files(&s.locks, &repo_path, &paths)).await
}

#[tauri::command]
pub async fn discard_files(state: State<'_, AppState>, repo_path: String, request: DiscardRequest) -> Result<OpResult> {
    let s = state.inner().clone();
    blocking(move || stage::discard_files(&s.locks, &repo_path, &request)).await
}

#[tauri::command]
pub async fn apply_patch(state: State<'_, AppState>, repo_path: String, request: ApplyPatchRequest) -> Result<OpResult> {
    let s = state.inner().clone();
    blocking(move || stage::apply_patch(&s.locks, &repo_path, &request)).await
}

#[tauri::command]
pub async fn commit(state: State<'_, AppState>, app: AppHandle, repo_path: String, request: CommitRequest) -> Result<CommitResult> {
    let s = state.inner().clone();
    blocking(move || {
        let mut cb = progress_cb(&app, &repo_path, GitOp::Commit);
        commit::commit(&s.locks, &repo_path, &request, &mut cb)
    })
    .await
}

#[tauri::command]
pub async fn resolve_conflict(state: State<'_, AppState>, repo_path: String, paths: Vec<String>, side: ConflictSide) -> Result<OpResult> {
    let s = state.inner().clone();
    blocking(move || stage::resolve_conflict(&s.locks, &repo_path, &paths, side)).await
}

#[tauri::command]
pub async fn open_in_editor(state: State<'_, AppState>, repo_path: String, path: String) -> Result<()> {
    let s = state.inner().clone();
    blocking(move || app::editor::open_in_editor(&repo_path, &path, s.persist.settings().external_editor.as_deref())).await
}

#[tauri::command]
pub async fn reveal_in_finder(repo_path: String, path: String) -> Result<()> {
    blocking(move || app::editor::reveal_in_finder(&repo_path, &path)).await
}

// ───────────── push ─────────────
#[tauri::command]
pub async fn get_push_preview(repo_path: String, local_branch: Option<String>) -> Result<PushPreview> {
    blocking(move || push::preview(&repo_path, local_branch.as_deref())).await
}

#[tauri::command]
pub async fn push(state: State<'_, AppState>, app: AppHandle, repo_path: String, request: PushRequest) -> Result<OpResult> {
    let s = state.inner().clone();
    blocking(move || {
        let mut cb = progress_cb(&app, &repo_path, GitOp::Push);
        push::push(&s.locks, &repo_path, &request, &mut cb)
    })
    .await
}

// ───────────── stash ─────────────
#[tauri::command]
pub async fn list_stashes(repo_path: String) -> Result<Vec<StashEntry>> {
    blocking(move || stash::list(&repo_path)).await
}

#[tauri::command]
pub async fn stash_save(state: State<'_, AppState>, repo_path: String, request: StashSaveRequest) -> Result<OpResult> {
    let s = state.inner().clone();
    blocking(move || stash::save(&s.locks, &repo_path, &request)).await
}

#[tauri::command]
pub async fn stash_apply(state: State<'_, AppState>, repo_path: String, stash: StashRef, pop: bool, restore_index: bool) -> Result<OpOutcome> {
    let s = state.inner().clone();
    blocking(move || stash::apply(&s.locks, &repo_path, &stash, pop, restore_index)).await
}

#[tauri::command]
pub async fn stash_drop(state: State<'_, AppState>, repo_path: String, stash: StashRef) -> Result<OpResult> {
    let s = state.inner().clone();
    blocking(move || stash::drop_entry(&s.locks, &repo_path, &stash)).await
}

// ───────────── merge / rebase / sequence / reset ─────────────
#[tauri::command]
pub async fn merge(state: State<'_, AppState>, app: AppHandle, repo_path: String, request: MergeRequest) -> Result<OpOutcome> {
    let s = state.inner().clone();
    blocking(move || {
        let mut cb = progress_cb(&app, &repo_path, GitOp::Merge);
        sequence::merge(&s.locks, &repo_path, &request, &mut cb)
    })
    .await
}

#[tauri::command]
pub async fn rebase(state: State<'_, AppState>, app: AppHandle, repo_path: String, onto: String) -> Result<OpOutcome> {
    let s = state.inner().clone();
    blocking(move || {
        let mut cb = progress_cb(&app, &repo_path, GitOp::Rebase);
        sequence::rebase(&s.locks, &repo_path, &onto, &mut cb)
    })
    .await
}

#[tauri::command]
pub async fn control_operation(
    state: State<'_, AppState>,
    app: AppHandle,
    repo_path: String,
    operation: RepoOperation,
    action: OperationAction,
) -> Result<OpOutcome> {
    let s = state.inner().clone();
    let op = match operation {
        RepoOperation::Merge => GitOp::Merge,
        RepoOperation::Rebase => GitOp::Rebase,
        RepoOperation::CherryPick => GitOp::CherryPick,
        RepoOperation::Revert => GitOp::Revert,
        RepoOperation::Bisect => GitOp::Rebase,
    };
    blocking(move || {
        let mut cb = progress_cb(&app, &repo_path, op);
        sequence::control_operation(&s.locks, &repo_path, operation, action, &mut cb)
    })
    .await
}

#[tauri::command]
pub async fn cherry_pick(state: State<'_, AppState>, app: AppHandle, repo_path: String, request: CherryPickRequest) -> Result<OpOutcome> {
    let s = state.inner().clone();
    blocking(move || {
        let mut cb = progress_cb(&app, &repo_path, GitOp::CherryPick);
        sequence::cherry_pick(&s.locks, &repo_path, &request, &mut cb)
    })
    .await
}

#[tauri::command]
pub async fn revert(state: State<'_, AppState>, app: AppHandle, repo_path: String, request: RevertRequest) -> Result<OpOutcome> {
    let s = state.inner().clone();
    blocking(move || {
        let mut cb = progress_cb(&app, &repo_path, GitOp::Revert);
        sequence::revert(&s.locks, &repo_path, &request, &mut cb)
    })
    .await
}

#[tauri::command]
pub async fn reset(state: State<'_, AppState>, repo_path: String, request: ResetRequest) -> Result<OpResult> {
    let s = state.inner().clone();
    blocking(move || sequence::reset(&s.locks, &repo_path, &request)).await
}

// ───────────── tags ─────────────
#[tauri::command]
pub async fn validate_tag_name(repo_path: String, name: String) -> Result<RefNameCheck> {
    blocking(move || tags::validate_tag_name(&repo_path, &name)).await
}

#[tauri::command]
pub async fn create_tag(state: State<'_, AppState>, repo_path: String, request: CreateTagRequest) -> Result<OpResult> {
    let s = state.inner().clone();
    blocking(move || tags::create_tag(&s.locks, &repo_path, &request)).await
}

#[tauri::command]
pub async fn delete_tag(state: State<'_, AppState>, repo_path: String, name: String) -> Result<OpResult> {
    let s = state.inner().clone();
    blocking(move || tags::delete_tag(&s.locks, &repo_path, &name)).await
}

#[tauri::command]
pub async fn push_tag(state: State<'_, AppState>, app: AppHandle, repo_path: String, remote: String, name: String) -> Result<OpResult> {
    let s = state.inner().clone();
    blocking(move || {
        let mut cb = progress_cb(&app, &repo_path, GitOp::Push);
        push::push_tag(&s.locks, &repo_path, &remote, &name, &mut cb)
    })
    .await
}

// ───────────── history exploration ─────────────
#[tauri::command]
pub async fn get_reflog(repo_path: String, r#ref: Option<String>, limit: Option<u32>) -> Result<Reflog> {
    blocking(move || reflog::reflog(&repo_path, r#ref.as_deref(), limit)).await
}

#[tauri::command]
pub async fn compare_refs(repo_path: String, a: String, b: String) -> Result<CompareSummary> {
    blocking(move || reflog::compare_refs(&repo_path, &a, &b)).await
}

#[tauri::command]
pub async fn get_line_history(repo_path: String, path: String, rev: Option<String>, range: LineRange) -> Result<LineHistory> {
    blocking(move || linehist::line_history(&repo_path, &path, rev.as_deref(), range)).await
}

// ───────────── app ─────────────
#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings> {
    Ok(state.persist.settings())
}

#[tauri::command]
pub async fn set_settings(state: State<'_, AppState>, app: AppHandle, settings: AppSettings) -> Result<AppSettings> {
    let s = state.inner().clone();
    let stored = blocking(move || {
        let old = s.persist.settings();
        let new = app_settings::store(&s.persist, settings)?;
        Ok((old, new))
    })
    .await?;
    let (old, new) = stored;
    if old.language != new.language {
        crate::apply_menu_language(&app);
    }
    tray::apply_settings(&app, &new);
    let _ = app.emit(EVENT_SETTINGS_CHANGED, &new);
    Ok(new)
}

#[tauri::command]
pub async fn validate_git_path(path: Option<String>) -> Result<GitPathCheck> {
    blocking(move || Ok(app_settings::validate_git_path(path.as_deref()))).await
}

#[tauri::command]
pub async fn get_diagnostics(app: AppHandle) -> Result<Diagnostics> {
    let version = app.package_info().version.to_string();
    blocking(move || Ok(app::diag::diagnostics(&version))).await
}

#[tauri::command]
pub async fn check_for_update(state: State<'_, AppState>, app: AppHandle) -> Result<Option<UpdateInfo>> {
    app::updater::check(&app, &state.pending_update).await
}

#[tauri::command]
pub async fn install_update(state: State<'_, AppState>, app: AppHandle) -> Result<()> {
    app::updater::install(&app, &state.pending_update).await
}

#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

// ───────────── menu bar ─────────────
#[tauri::command]
pub async fn get_repo_summaries(state: State<'_, AppState>, tray_state: State<'_, tray::Tray>) -> Result<Vec<RepoSummary>> {
    let s = state.inner().clone();
    let cache = tray_state.cache();
    blocking(move || Ok(tray::summary::collect(&s, &cache))).await
}

#[tauri::command]
pub async fn open_quick_commit(app: AppHandle, tray_state: State<'_, tray::Tray>, repo_path: String) -> Result<()> {
    tray::quick_window::open(&app, &tray_state.quick, &repo_path)
}

#[tauri::command]
pub async fn show_main_window(app: AppHandle, repo_path: Option<String>) -> Result<()> {
    tray::lifecycle::show_main_window(&app, repo_path);
    Ok(())
}

#[tauri::command]
pub async fn get_quick_commit_target(tray_state: State<'_, tray::Tray>) -> Result<Option<String>> {
    Ok(tray_state.quick.target())
}

#[tauri::command]
pub async fn set_quick_commit_busy(tray_state: State<'_, tray::Tray>, busy: bool) -> Result<()> {
    tray_state.quick.set_busy(busy);
    Ok(())
}
