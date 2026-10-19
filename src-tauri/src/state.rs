//! Application state + core entry points that need more than one module (testable without Tauri).
use crate::error::Result;
use crate::git::{ops::RepoLocks, repo};
use crate::models::RepoInfo;
use crate::persist::Persist;
use crate::snapshot::SnapshotStore;
use crate::watcher::{Emitter, Watchers};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct AppState {
    pub snapshots: Arc<SnapshotStore>,
    pub persist: Arc<Persist>,
    pub locks: Arc<RepoLocks>,
    pub watchers: Arc<Watchers>,
    /// repos that have a tab in the main window (path as returned by open_repo)
    pub open_repos: Arc<Mutex<Vec<String>>>,
    pub pending_update: crate::app::updater::Pending,
}

impl AppState {
    pub fn new(state_file: Option<PathBuf>) -> Self {
        AppState {
            snapshots: Arc::new(SnapshotStore::default()),
            persist: Arc::new(Persist::new(state_file)),
            locks: Arc::new(RepoLocks::default()),
            watchers: Arc::new(Watchers::default()),
            open_repos: Arc::new(Mutex::new(Vec::new())),
            pending_update: Arc::new(Mutex::new(None)),
        }
    }

    /// open_repo: resolve repo, push to recents, (re)start watcher.
    pub fn open_repo(&self, path: &str, emit: Emitter) -> Result<RepoInfo> {
        let info = repo::open_repo_info(path)?;
        self.persist.push_recent(&info.path, &info.name);
        // A watcher failure must not prevent opening the repo.
        let _ = self.watchers.start(&info.path, &info.git_dir, &info.common_dir, emit);
        let mut open = self.open_repos.lock().unwrap_or_else(|p| p.into_inner());
        let key = crate::git::repo::canonical_key(&info.path);
        if !open.iter().any(|p| crate::git::repo::canonical_key(p) == key) {
            open.push(info.path.clone());
        }
        Ok(info)
    }

    pub fn close_repo(&self, repo_path: &str) {
        self.watchers.stop(repo_path);
        let key = crate::git::repo::canonical_key(repo_path);
        self.open_repos.lock().unwrap_or_else(|p| p.into_inner()).retain(|p| crate::git::repo::canonical_key(p) != key);
        self.snapshots.release_repo(repo_path);
    }
}

impl AppState {
    pub fn open_repo_paths(&self) -> Vec<String> {
        self.open_repos.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}
