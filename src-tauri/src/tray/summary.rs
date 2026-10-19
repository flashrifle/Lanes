//! `RepoSummary` derivation. Always from `status::read` (never a separate walk).
use super::model::{MAX_REPOS, order_and_limit};
use crate::git::status;
use crate::models::*;
use crate::state::AppState;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const RECENT_TTL: Duration = Duration::from_secs(60);

fn base_name(path: &str) -> String {
    Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

/// Pure derivation from a status snapshot.
pub fn from_status(path: &str, name: &str, open: bool, st: &WorkingTreeStatus, last_fetch: Option<i64>) -> RepoSummary {
    RepoSummary {
        path: path.to_string(),
        name: name.to_string(),
        open,
        branch: st.branch.clone(),
        head_hash: st.head_hash.clone(),
        upstream: st.upstream.clone(),
        ahead: st.ahead,
        behind: st.behind,
        changed_count: st.files.len() as u32,
        staged_count: st.files.iter().filter(|f| f.staged.is_some()).count() as u32,
        conflict_count: st.files.iter().filter(|f| f.conflict.is_some()).count() as u32,
        operation: st.operation.as_ref().map(|o| o.operation),
        last_fetch,
        error: None,
    }
}

pub fn error_summary(path: &str, name: &str, open: bool, msg: &str) -> RepoSummary {
    RepoSummary {
        path: path.to_string(),
        name: name.to_string(),
        open,
        branch: None,
        head_hash: None,
        upstream: None,
        ahead: None,
        behind: None,
        changed_count: 0,
        staged_count: 0,
        conflict_count: 0,
        operation: None,
        last_fetch: None,
        error: Some(msg.to_string()),
    }
}

fn fetch_time(repo: &str) -> Option<i64> {
    let gd = status::git_dir_of(repo).ok()?;
    let m = std::fs::metadata(Path::new(&gd).join("FETCH_HEAD")).ok()?.modified().ok()?;
    m.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs() as i64)
}

pub fn read_summary(path: &str, name: &str, open: bool) -> RepoSummary {
    if !Path::new(path).exists() {
        return error_summary(path, name, open, "folder not found");
    }
    match status::read(path) {
        Ok(st) => from_status(path, name, open, &st, fetch_time(path)),
        Err(e) => error_summary(path, name, open, &e.message),
    }
}

#[derive(Default)]
pub struct RecentCache(Mutex<HashMap<String, (Instant, RepoSummary)>>);

impl RecentCache {
    fn get(&self, path: &str, now: Instant) -> Option<RepoSummary> {
        let m = self.0.lock().unwrap_or_else(|p| p.into_inner());
        m.get(path).filter(|(t, _)| now.duration_since(*t) <= RECENT_TTL).map(|(_, s)| s.clone())
    }
    fn put(&self, s: &RepoSummary, now: Instant) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).insert(s.path.clone(), (now, s.clone()));
    }
}

/// Open repos first (by name), then existing recents; at most 8. Recents are cached for <= 60 s.
pub fn collect(state: &AppState, cache: &RecentCache) -> Vec<RepoSummary> {
    let open_paths = state.open_repo_paths();
    let mut candidates: Vec<(String, String, bool)> =
        open_paths.iter().map(|p| (p.clone(), base_name(p), true)).collect();
    candidates.sort_by_key(|(_, n, _)| n.to_lowercase());
    for r in state.persist.recents() {
        let key = crate::git::repo::canonical_key(&r.path);
        if r.exists && !open_paths.iter().any(|o| crate::git::repo::canonical_key(o) == key) {
            candidates.push((r.path, r.name, false));
        }
    }
    candidates.truncate(MAX_REPOS);
    let now = Instant::now();
    let out = candidates
        .into_iter()
        .map(|(path, name, open)| {
            if open {
                return read_summary(&path, &name, true);
            }
            if let Some(s) = cache.get(&path, now) {
                return s;
            }
            let s = read_summary(&path, &name, false);
            cache.put(&s, now);
            s
        })
        .collect();
    order_and_limit(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_counts() {
        let f = |p: &str, staged: Option<FileStatus>, conflict: Option<ConflictKind>| StatusFile {
            path: p.into(),
            old_path: None,
            staged,
            unstaged: None,
            untracked: false,
            conflict,
            submodule: false,
        };
        let st = WorkingTreeStatus {
            head_hash: Some("h".into()),
            branch: Some("main".into()),
            upstream: Some("refs/remotes/origin/main".into()),
            ahead: Some(1),
            behind: Some(2),
            files: vec![f("a", Some(FileStatus::Added), None), f("b", None, None), f("c", None, Some(ConflictKind::BothModified))],
            truncated: false,
            operation: Some(OperationState {
                operation: RepoOperation::Merge,
                head_name: None,
                onto_hash: None,
                stopped_at: None,
                step: None,
                total: None,
                can_continue: false,
                can_skip: false,
            }),
        };
        let s = from_status("/r/app", "app", true, &st, Some(5));
        assert_eq!((s.changed_count, s.staged_count, s.conflict_count), (3, 1, 1));
        assert_eq!((s.ahead, s.behind, s.last_fetch), (Some(1), Some(2), Some(5)));
        assert_eq!(s.operation, Some(RepoOperation::Merge));
        assert!(s.open && s.error.is_none());
        let e = error_summary("/gone", "gone", false, "folder not found");
        assert_eq!(e.error.as_deref(), Some("folder not found"));
    }

    #[test]
    fn recent_cache_expires() {
        let c = RecentCache::default();
        let s = error_summary("/p", "p", false, "x");
        let t0 = Instant::now();
        c.put(&s, t0);
        assert!(c.get("/p", t0 + Duration::from_secs(59)).is_some());
        assert!(c.get("/p", t0 + Duration::from_secs(61)).is_none());
    }
}
