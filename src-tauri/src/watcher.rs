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
/// Work-tree events are noisy (builds, editors): longer debounce.
pub const WORKTREE_DEBOUNCE: Duration = Duration::from_millis(1000);

pub type Emitter = Arc<dyn Fn(RepoChangedEvent) + Send + Sync>;

/// Classify a path relative to a git dir. None = irrelevant (locks, objects, logs...).
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
        "index" if comps.len() == 1 => Some(RepoChangeScope::Index),
        _ => None,
    }
}

/// Directories the watcher cares about: git dirs `(root, per_worktree)` and work-tree roots.
#[derive(Debug, Clone, Default)]
pub struct Roots {
    pub git: Vec<(PathBuf, bool)>,
    pub worktree: Vec<PathBuf>,
}

fn is_noise(path: &Path) -> bool {
    path.components().any(|c| {
        let n = c.as_os_str();
        n == ".git" || n == ".DS_Store"
    })
}

/// A shared common dir of a linked worktree (per_worktree = false) only contributes refs /
/// packed-refs / FETCH_HEAD; HEAD, index and operation files there belong to the main worktree.
/// Anything under a work-tree root that is not inside a git dir is a `worktree` change.
pub fn classify(path: &Path, roots: &Roots) -> Option<RepoChangeScope> {
    if let Some((rel, per_worktree)) = roots.git.iter().find_map(|(d, pw)| path.strip_prefix(d).ok().map(|r| (r, *pw))) {
        let scope = classify_rel(rel)?;
        return (per_worktree || matches!(scope, RepoChangeScope::Refs | RepoChangeScope::FetchHead)).then_some(scope);
    }
    let rel = roots.worktree.iter().find_map(|w| path.strip_prefix(w).ok())?;
    if rel.as_os_str().is_empty() || is_noise(rel) {
        return None;
    }
    Some(RepoChangeScope::Worktree)
}

fn debounce_for(scope: RepoChangeScope) -> Duration {
    if scope == RepoChangeScope::Worktree { WORKTREE_DEBOUNCE } else { DEBOUNCE }
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
        let mut roots = Roots::default();
        let add_git = |r: &str, pw: bool, roots: &mut Roots| {
            let p = PathBuf::from(r);
            roots.git.push((p.clone(), pw));
            if let Ok(c) = p.canonicalize()
                && c != p
            {
                roots.git.push((c, pw));
            }
        };
        add_git(git_dir, true, &mut roots);
        if common_dir != git_dir {
            add_git(common_dir, false, &mut roots);
        }
        let wt = PathBuf::from(repo_path);
        roots.worktree.push(wt.clone());
        if let Ok(c) = wt.canonicalize()
            && c != wt
        {
            roots.worktree.push(c);
        }
        // Watch the work tree recursively (covers an in-tree .git); git dirs outside it separately.
        let mut to_watch = vec![wt.clone()];
        let wt_canon = wt.canonicalize().unwrap_or_else(|_| wt.clone());
        for d in [git_dir, common_dir] {
            let p = PathBuf::from(d);
            let inside = p.starts_with(&wt) || p.canonicalize().map(|c| c.starts_with(&wt_canon)).unwrap_or(false);
            if !inside && !to_watch.contains(&p) {
                to_watch.push(p);
            }
        }
        for r in &to_watch {
            watcher
                .watch(r, RecursiveMode::Recursive)
                .map_err(|e| AppError::internal(format!("watch {}: {e}", r.display())))?;
        }
        let repo_path = repo_path.to_string();
        std::thread::spawn(move || debounce_loop(rx, roots, repo_path, emit));
        Ok(RepoWatcher { _watchers: watcher })
    }
}

fn debounce_loop(rx: mpsc::Receiver<notify::Result<Event>>, roots: Roots, repo_path: String, emit: Emitter) {
    // scope -> time at which it is due (each new event pushes it out again)
    let mut pending: Vec<(RepoChangeScope, Instant)> = Vec::new();
    loop {
        let next_due = pending.iter().map(|(_, d)| *d).min();
        let res = match next_due {
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(d) => rx.recv_timeout(d.saturating_duration_since(Instant::now())),
        };
        match res {
            Ok(Ok(ev)) => {
                if matches!(ev.kind, EventKind::Access(_)) {
                    continue;
                }
                for p in &ev.paths {
                    if let Some(s) = classify(p, &roots) {
                        let due = Instant::now() + debounce_for(s);
                        match pending.iter_mut().find(|(k, _)| *k == s) {
                            Some(e) => e.1 = due,
                            None => pending.push((s, due)),
                        }
                    }
                }
            }
            Ok(Err(_)) => {}
            Err(RecvTimeoutError::Timeout) => {
                let now = Instant::now();
                let mut scopes: Vec<RepoChangeScope> = pending.iter().filter(|(_, d)| *d <= now).map(|(s, _)| *s).collect();
                pending.retain(|(_, d)| *d > now);
                if !scopes.is_empty() {
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
        assert_eq!(c("index.lock"), None);
        assert_eq!(c("objects/ab/cdef"), None);
        assert_eq!(c("index"), Some(RepoChangeScope::Index));
        assert_eq!(c("logs/HEAD"), None);
        assert_eq!(c("FETCH_HEAD"), Some(RepoChangeScope::FetchHead));
        assert_eq!(c("rebase-merge/done"), Some(RepoChangeScope::Operation));
        assert_eq!(c("MERGE_HEAD"), Some(RepoChangeScope::Operation));
    }

    fn roots() -> Roots {
        Roots { git: vec![(PathBuf::from("/r/.git"), true)], worktree: vec![PathBuf::from("/r")] }
    }

    #[test]
    fn index_vs_worktree() {
        let r = roots();
        let c = |s: &str| classify(Path::new(s), &r);
        assert_eq!(c("/r/.git/index"), Some(RepoChangeScope::Index));
        assert_eq!(c("/r/.git/index.lock"), None);
        assert_eq!(c("/r/.git/objects/ab/cd"), None);
        assert_eq!(c("/r/src/main.rs"), Some(RepoChangeScope::Worktree));
        assert_eq!(c("/r/a/b/c.txt"), Some(RepoChangeScope::Worktree));
        assert_eq!(c("/r"), None);
        assert_eq!(c("/r/.DS_Store"), None);
        assert_eq!(c("/r/sub/.git/HEAD"), None);
        assert_eq!(c("/elsewhere/file"), None);
        assert_eq!(c("/r/.git/refs/heads/x"), Some(RepoChangeScope::Refs));
        assert_eq!(debounce_for(RepoChangeScope::Worktree), Duration::from_millis(1000));
        assert_eq!(debounce_for(RepoChangeScope::Index), DEBOUNCE);
    }

    #[test]
    fn common_dir_of_linked_worktree_only_refs() {
        let roots = Roots {
            git: vec![(PathBuf::from("/r/.git/worktrees/w"), true), (PathBuf::from("/r/.git"), false)],
            worktree: vec![PathBuf::from("/w")],
        };
        let c = |s: &str| classify(Path::new(s), &roots);
        assert_eq!(c("/r/.git/refs/heads/x"), Some(RepoChangeScope::Refs));
        assert_eq!(c("/r/.git/packed-refs"), Some(RepoChangeScope::Refs));
        assert_eq!(c("/r/.git/FETCH_HEAD"), Some(RepoChangeScope::FetchHead));
        assert_eq!(c("/r/.git/HEAD"), None);
        assert_eq!(c("/r/.git/index"), None);
        assert_eq!(c("/r/.git/MERGE_HEAD"), None);
        assert_eq!(c("/r/.git/worktrees/w/HEAD"), Some(RepoChangeScope::Head));
        assert_eq!(c("/r/.git/worktrees/w/index"), Some(RepoChangeScope::Index));
        assert_eq!(c("/r/.git/worktrees/w/MERGE_HEAD"), Some(RepoChangeScope::Operation));
        assert_eq!(c("/w/file.txt"), Some(RepoChangeScope::Worktree));
    }
}
