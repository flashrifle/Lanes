use crate::error::{AppError, Result};
use crate::git::repo::canonical_key;
use crate::models::{RepoChangeScope, RepoChangedEvent};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const DEBOUNCE: Duration = Duration::from_millis(400);

pub type Emitter = Arc<dyn Fn(RepoChangedEvent) + Send + Sync>;

/// Classify a path relative to a git dir. None = irrelevant (locks, objects, logs, index...).
pub fn classify_rel(rel: &Path) -> Option<RepoChangeScope> {
    let comps: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    let first = comps.first()?;
    if comps.iter().any(|c| c.ends_with(".lock")) {
        return None;
    }
    match first.as_str() {
        "HEAD" | "ORIG_HEAD" => Some(RepoChangeScope::Head),
        "FETCH_HEAD" => Some(RepoChangeScope::FetchHead),
        "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" | "BISECT_LOG" => Some(RepoChangeScope::Operation),
        s if s.starts_with("rebase-") => Some(RepoChangeScope::Operation),
        "packed-refs" | "refs" => Some(RepoChangeScope::Refs),
        _ => None,
    }
}

/// `dirs` are (root, per_worktree). A shared common dir of a linked worktree (per_worktree =
/// false) only contributes refs / packed-refs / FETCH_HEAD; HEAD, index-like and operation files
/// there belong to the main worktree.
fn classify(path: &Path, dirs: &[(PathBuf, bool)]) -> Option<RepoChangeScope> {
    let (rel, per_worktree) = dirs.iter().find_map(|(d, pw)| path.strip_prefix(d).ok().map(|r| (r, *pw)))?;
    let scope = classify_rel(rel)?;
    (per_worktree || matches!(scope, RepoChangeScope::Refs | RepoChangeScope::FetchHead)).then_some(scope)
}

pub struct RepoWatcher {
    _watchers: RecommendedWatcher,
}

impl RepoWatcher {
    pub fn start(repo_path: &str, git_dir: &str, common_dir: &str, emit: Emitter) -> Result<RepoWatcher> {
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = tx.send(res);
        })
        .map_err(|e| AppError::internal(format!("watcher: {e}")))?;
        let mut roots = vec![(PathBuf::from(git_dir), true)];
        if common_dir != git_dir {
            roots.push((PathBuf::from(common_dir), false));
        }
        let mut dirs = Vec::new();
        for (r, pw) in &roots {
            watcher
                .watch(r, RecursiveMode::Recursive)
                .map_err(|e| AppError::internal(format!("watch {}: {e}", r.display())))?;
            dirs.push((r.clone(), *pw));
            if let Ok(c) = r.canonicalize()
                && &c != r {
                    dirs.push((c, *pw));
                }
        }
        let repo_path = repo_path.to_string();
        std::thread::spawn(move || debounce_loop(rx, dirs, repo_path, emit));
        Ok(RepoWatcher { _watchers: watcher })
    }
}

fn debounce_loop(rx: mpsc::Receiver<notify::Result<Event>>, dirs: Vec<(PathBuf, bool)>, repo_path: String, emit: Emitter) {
    let mut pending: Vec<RepoChangeScope> = Vec::new();
    let mut deadline: Option<Instant> = None;
    loop {
        let res = match deadline {
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(d) => rx.recv_timeout(d.saturating_duration_since(Instant::now())),
        };
        match res {
            Ok(Ok(ev)) => {
                if matches!(ev.kind, EventKind::Access(_)) {
                    continue;
                }
                let mut relevant = false;
                for p in &ev.paths {
                    if let Some(s) = classify(p, &dirs) {
                        relevant = true;
                        if !pending.contains(&s) {
                            pending.push(s);
                        }
                    }
                }
                if relevant {
                    deadline = Some(Instant::now() + DEBOUNCE);
                }
            }
            Ok(Err(_)) => {}
            Err(RecvTimeoutError::Timeout) => {
                deadline = None;
                if !pending.is_empty() {
                    let mut scopes = std::mem::take(&mut pending);
                    scopes.sort();
                    emit(RepoChangedEvent { repo_path: repo_path.clone(), scopes });
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

#[derive(Default)]
pub struct Watchers(Mutex<HashMap<String, RepoWatcher>>);

impl Watchers {
    pub fn start(&self, repo_path: &str, git_dir: &str, common_dir: &str, emit: Emitter) -> Result<()> {
        let w = RepoWatcher::start(repo_path, git_dir, common_dir, emit)?;
        // replaces (and drops) any previous watcher for the same repo; other repos are untouched
        self.0.lock().unwrap_or_else(|p| p.into_inner()).insert(canonical_key(repo_path), w);
        Ok(())
    }
    pub fn stop(&self, repo_path: &str) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).remove(&canonical_key(repo_path));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies() {
        let c = |s: &str| classify_rel(Path::new(s));
        assert_eq!(c("HEAD"), Some(RepoChangeScope::Head));
        assert_eq!(c("refs/heads/main"), Some(RepoChangeScope::Refs));
        assert_eq!(c("packed-refs"), Some(RepoChangeScope::Refs));
        assert_eq!(c("refs/heads/main.lock"), None);
        assert_eq!(c("HEAD.lock"), None);
        assert_eq!(c("objects/ab/cdef"), None);
        assert_eq!(c("index"), None);
        assert_eq!(c("logs/HEAD"), None);
        assert_eq!(c("FETCH_HEAD"), Some(RepoChangeScope::FetchHead));
        assert_eq!(c("rebase-merge/done"), Some(RepoChangeScope::Operation));
        assert_eq!(c("MERGE_HEAD"), Some(RepoChangeScope::Operation));
    }

    #[test]
    fn common_dir_of_linked_worktree_only_refs() {
        let dirs = vec![(PathBuf::from("/r/.git/worktrees/w"), true), (PathBuf::from("/r/.git"), false)];
        let c = |s: &str| classify(Path::new(s), &dirs);
        assert_eq!(c("/r/.git/refs/heads/x"), Some(RepoChangeScope::Refs));
        assert_eq!(c("/r/.git/packed-refs"), Some(RepoChangeScope::Refs));
        assert_eq!(c("/r/.git/FETCH_HEAD"), Some(RepoChangeScope::FetchHead));
        assert_eq!(c("/r/.git/HEAD"), None);
        assert_eq!(c("/r/.git/MERGE_HEAD"), None);
        assert_eq!(c("/r/.git/worktrees/w/HEAD"), Some(RepoChangeScope::Head));
        assert_eq!(c("/r/.git/worktrees/w/MERGE_HEAD"), Some(RepoChangeScope::Operation));
    }
}
