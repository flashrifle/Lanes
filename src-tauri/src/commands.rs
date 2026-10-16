use crate::error::{AppError, Result};
use crate::git::{changes, diff, log, ops, refs};
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
    let emit: Emitter = Arc::new(move |ev| {
        let _ = app.emit(EVENT_REPO_CHANGED, ev);
    });
    blocking(move || s.open_repo(&path, emit)).await
}

#[tauri::command]
pub async fn close_repo(state: State<'_, AppState>, repo_path: String) -> Result<()> {
    let s = state.inner().clone();
    blocking(move || {
        s.close_repo(&repo_path);
        Ok(())
    })
    .await
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
