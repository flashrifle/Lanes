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

/// A scope is emitted at the latest this long after its first pending event, however long events keep arriving.
pub const MAX_WAIT: Duration = Duration::from_secs(5);
/// Worktree paths remembered per debounce window for the ignore check; more than this skips the check.
const MAX_TRACKED_PATHS: usize = 512;

/// How long to wait for the next event before a debounce window that started at `first` must close:
/// `None` once `max` has elapsed (emit now), else `debounce` capped by the remaining max wait.
pub fn debounce_timeout(first: Instant, now: Instant, debounce: Duration, max: Duration) -> Option<Duration> {
    let left = max.checked_sub(now.saturating_duration_since(first))?;
    (!left.is_zero()).then(|| debounce.min(left))
}

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

/// Pending (not yet emitted) scopes of one repo with their debounce deadlines.
#[derive(Default)]
struct Pending {
    entries: Vec<Entry>,
}

struct Entry {
    scope: RepoChangeScope,
    /// each new event pushes this out, but never past `first + MAX_WAIT`
    due: Instant,
    first: Instant,
    /// worktree scope only: the changed paths of the window (for the ignore check)
    paths: Vec<PathBuf>,
    overflow: bool,
}

struct Due {
    scope: RepoChangeScope,
    paths: Vec<PathBuf>,
    overflow: bool,
}

impl Pending {
    fn push(&mut self, scope: RepoChangeScope, path: &Path, now: Instant) {
        let idx = match self.entries.iter().position(|e| e.scope == scope) {
            Some(i) => i,
            None => {
                self.entries.push(Entry { scope, due: now, first: now, paths: Vec::new(), overflow: false });
                self.entries.len() - 1
            }
        };
        let e = &mut self.entries[idx];
        e.due = (now + debounce_for(scope)).min(e.first + MAX_WAIT);
        if scope == RepoChangeScope::Worktree && !e.overflow {
            if e.paths.len() >= MAX_TRACKED_PATHS {
                e.overflow = true;
                e.paths.clear();
            } else if !e.paths.iter().any(|p| p == path) {
                e.paths.push(path.to_path_buf());
            }
        }
    }

    fn next_due(&self) -> Option<Instant> {
        self.entries.iter().map(|e| e.due).min()
    }

    fn take_due(&mut self, now: Instant) -> Vec<Due> {
        let mut out = Vec::new();
        self.entries.retain_mut(|e| {
            if e.due > now {
                return true;
            }
            out.push(Due { scope: e.scope, paths: std::mem::take(&mut e.paths), overflow: e.overflow });
            false
        });
        out
    }
}

/// Is at least one of the changed worktree `paths` not ignored by git? One batched
/// `git check-ignore --stdin -z`; any doubt (overflow, git failure) counts as "yes".
fn worktree_has_unignored(repo_path: &str, roots: &Roots, paths: &[PathBuf], overflow: bool) -> bool {
    if overflow || paths.is_empty() {
        return true;
    }
    let mut rels: Vec<Vec<u8>> = Vec::new();
    for p in paths {
        let Some(rel) = roots.worktree.iter().find_map(|w| p.strip_prefix(w).ok()) else { return true };
        rels.push(path_bytes(rel));
    }
    let mut input = Vec::new();
    for r in &rels {
        input.extend_from_slice(r);
        input.push(0);
    }
    let Ok(o) = crate::git::runner::run_stdin_raw(repo_path, &["check-ignore", "--stdin", "-z"], input, true) else {
        return true;
    };
    match o.code {
        // 1 = none of the paths is ignored
        1 => true,
        0 => {
            let ignored: std::collections::HashSet<&[u8]> = o.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()).collect();
            rels.iter().any(|r| !ignored.contains(r.as_slice()))
        }
        _ => true,
    }
}

#[cfg(unix)]
fn path_bytes(p: &Path) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    p.as_os_str().as_bytes().to_vec()
}

#[cfg(not(unix))]
fn path_bytes(p: &Path) -> Vec<u8> {
    p.to_string_lossy().replace('\\', "/").into_bytes()
}

fn debounce_loop(rx: mpsc::Receiver<notify::Result<Event>>, roots: Roots, repo_path: String, emit: Emitter) {
    let mut pending = Pending::default();
    loop {
        let res = match pending.next_due() {
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(d) => rx.recv_timeout(d.saturating_duration_since(Instant::now())),
        };
        match res {
            Ok(Ok(ev)) => {
                if matches!(ev.kind, EventKind::Access(_)) {
                    continue;
                }
                let now = Instant::now();
                for p in &ev.paths {
                    if let Some(s) = classify(p, &roots) {
                        pending.push(s, p, now);
                    }
                }
            }
            Ok(Err(_)) => {}
            Err(RecvTimeoutError::Timeout) => {
                // a steady event stream keeps `recv_timeout` from timing out: also flush after every event
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
        let mut scopes: Vec<RepoChangeScope> = Vec::new();
        for d in pending.take_due(Instant::now()) {
            if d.scope == RepoChangeScope::Worktree && !worktree_has_unignored(&repo_path, &roots, &d.paths, d.overflow) {
                continue;
            }
            scopes.push(d.scope);
        }
        if !scopes.is_empty() {
            scopes.sort();
            emit(RepoChangedEvent { repo_path: repo_path.clone(), scopes });
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
    fn max_wait_caps_a_steady_event_stream() {
        let t0 = Instant::now();
        let mut p = Pending::default();
        // an event every 300 ms for 8 s would postpone a 400 ms debounce forever
        let mut flushed_at = None;
        for i in 0..27u64 {
            let now = t0 + Duration::from_millis(300 * i);
            if !p.take_due(now).is_empty() {
                flushed_at = Some(300 * i);
                break;
            }
            p.push(RepoChangeScope::Index, Path::new("index"), now);
        }
        let at = flushed_at.expect("flushed despite continuous events");
        assert!((5000..=5400).contains(&at), "flushed at {at} ms");
        // the worktree scope is capped too, and dedups paths
        let mut p = Pending::default();
        p.push(RepoChangeScope::Worktree, Path::new("/r/a"), t0);
        p.push(RepoChangeScope::Worktree, Path::new("/r/a"), t0 + Duration::from_millis(900));
        assert_eq!(p.entries[0].paths.len(), 1);
        p.push(RepoChangeScope::Worktree, Path::new("/r/a"), t0 + Duration::from_millis(4900));
        assert_eq!(p.next_due(), Some(t0 + MAX_WAIT));
    }

    #[test]
    fn ignored_worktree_paths_are_dropped() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().canonicalize().unwrap();
        let git = |args: &[&str]| {
            let o = std::process::Command::new("git").arg("-C").arg(&root).args(args).output().unwrap();
            assert!(o.status.success(), "{args:?}: {}", String::from_utf8_lossy(&o.stderr));
        };
        git(&["init", "-q"]);
        std::fs::write(root.join(".gitignore"), "node_modules/\ntarget\n*.log\n").unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::write(root.join("node_modules/x/i.js"), "1").unwrap();
        std::fs::write(root.join("src.txt"), "1").unwrap();
        let roots = Roots { git: vec![(root.join(".git"), true)], worktree: vec![root.clone()] };
        let repo = root.to_str().unwrap();
        let p = |s: &str| root.join(s);
        // only ignored paths: no event
        assert!(!worktree_has_unignored(repo, &roots, &[p("node_modules/x/i.js"), p("target/debug/a"), p("build.log")], false));
        // one real change among ignored ones: event
        assert!(worktree_has_unignored(repo, &roots, &[p("node_modules/x/i.js"), p("src.txt")], false));
        // the ignore file itself, and a tracked file inside an ignored pattern, are real changes
        assert!(worktree_has_unignored(repo, &roots, &[p(".gitignore")], false));
        std::fs::write(root.join("tracked.log"), "1").unwrap();
        git(&["add", "-f", "tracked.log"]);
        assert!(worktree_has_unignored(repo, &roots, &[p("tracked.log")], false));
        // overflow / empty: assume a change
        assert!(worktree_has_unignored(repo, &roots, &[], false));
        assert!(worktree_has_unignored(repo, &roots, &[p("target/x")], true));
    }

    #[test]
    fn debounce_timeout_math() {
        let t0 = Instant::now();
        let d = Duration::from_secs(1);
        assert_eq!(debounce_timeout(t0, t0, d, MAX_WAIT), Some(d));
        assert_eq!(debounce_timeout(t0, t0 + Duration::from_millis(4500), d, MAX_WAIT), Some(Duration::from_millis(500)));
        assert_eq!(debounce_timeout(t0, t0 + MAX_WAIT, d, MAX_WAIT), None);
        assert_eq!(debounce_timeout(t0, t0 + Duration::from_secs(9), d, MAX_WAIT), None);
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
