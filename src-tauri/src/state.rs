//! Application state + core entry points that need more than one module (testable without Tauri).
use crate::error::Result;
use crate::git::{ops::RepoLocks, repo};
use crate::models::RepoInfo;
use crate::persist::Persist;
use crate::snapshot::SnapshotStore;
use crate::watcher::{Emitter, Watchers};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub snapshots: Arc<SnapshotStore>,
    pub persist: Arc<Persist>,
    pub locks: Arc<RepoLocks>,
    pub watchers: Arc<Watchers>,
}

impl AppState {
    pub fn new(state_file: Option<PathBuf>) -> Self {
        AppState {
            snapshots: Arc::new(SnapshotStore::default()),
            persist: Arc::new(Persist::new(state_file)),
            locks: Arc::new(RepoLocks::default()),
            watchers: Arc::new(Watchers::default()),
        }
    }

    /// open_repo: resolve repo, push to recents, (re)start watcher.
    pub fn open_repo(&self, path: &str, emit: Emitter) -> Result<RepoInfo> {
        let info = repo::open_repo_info(path)?;
        self.persist.push_recent(&info.path, &info.name);
        // A watcher failure must not prevent opening the repo.
        let _ = self.watchers.start(&info.path, &info.git_dir, &info.common_dir, emit);
        Ok(info)
    }

    pub fn close_repo(&self, repo_path: &str) {
        self.watchers.stop(repo_path);
        self.snapshots.release_repo(repo_path);
    }
}
