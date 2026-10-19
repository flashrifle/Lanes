//! Background fetch: every `backgroundFetchMinutes` (15 / 30 / 60) for each open repo that has remotes.
use crate::git::{ops, runner};
use crate::error::ErrorCode;
use crate::state::AppState;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const TICK: Duration = Duration::from_secs(30);

/// Pure scheduling: when is each repo next due, which are paused after an auth failure.
#[derive(Default)]
pub struct Scheduler {
    last: HashMap<String, Instant>,
    paused: HashSet<String>,
}

impl Scheduler {
    /// Repos due now. A repo seen for the first time is scheduled `interval` from now, not fetched at once.
    pub fn due(&mut self, now: Instant, interval: Duration, repos: &[String]) -> Vec<String> {
        self.last.retain(|k, _| repos.contains(k));
        self.paused.retain(|k| repos.contains(k));
        let mut out = Vec::new();
        for r in repos {
            if self.paused.contains(r) {
                continue;
            }
            match self.last.get(r) {
                None => {
                    self.last.insert(r.clone(), now);
                }
                Some(t) if now.saturating_duration_since(*t) >= interval => out.push(r.clone()),
                Some(_) => {}
            }
        }
        out
    }
    pub fn mark_run(&mut self, repo: &str, now: Instant) {
        self.last.insert(repo.to_string(), now);
    }
    /// Returns true when this call newly paused the repo (so the caller notifies once).
    pub fn pause(&mut self, repo: &str) -> bool {
        self.paused.insert(repo.to_string())
    }
    pub fn resume_all(&mut self) {
        self.paused.clear();
    }
    pub fn is_paused(&self, repo: &str) -> bool {
        self.paused.contains(repo)
    }
}

#[derive(Default)]
pub struct Background {
    pub scheduler: Mutex<Scheduler>,
}

impl Background {
    fn sched(&self) -> std::sync::MutexGuard<'_, Scheduler> {
        self.scheduler.lock().unwrap_or_else(|p| p.into_inner())
    }
    pub fn resume_all(&self) {
        self.sched().resume_all();
    }

    /// One scheduler tick. `notify_auth(repo)` is called once when a repo is paused.
    pub fn tick(&self, state: &AppState, now: Instant, notify_auth: &mut dyn FnMut(&str), after_fetch: &mut dyn FnMut()) {
        let Some(minutes) = state.persist.settings().background_fetch_minutes else { return };
        let repos = state.open_repo_paths();
        let due = self.sched().due(now, Duration::from_secs(u64::from(minutes) * 60), &repos);
        for repo in due {
            let has_remote = runner::run(&repo, &["remote"], true).map(|o| !o.stdout.is_empty()).unwrap_or(false);
            if !has_remote {
                self.sched().mark_run(&repo, now);
                continue;
            }
            match ops::fetch(&state.locks, &repo, None, &mut |_| {}) {
                Ok(_) => {
                    self.sched().mark_run(&repo, Instant::now());
                    after_fetch();
                }
                // another op holds the lock: skip silently, retry next tick
                Err(e) if e.code == ErrorCode::Busy => {}
                Err(e) if e.code == ErrorCode::AuthFailed => {
                    if self.sched().pause(&repo) {
                        notify_auth(&repo);
                    }
                }
                Err(_) => self.sched().mark_run(&repo, Instant::now()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedules_by_interval() {
        let mut s = Scheduler::default();
        let t0 = Instant::now();
        let iv = Duration::from_secs(900);
        let repos = vec!["/a".to_string(), "/b".to_string()];
        assert!(s.due(t0, iv, &repos).is_empty()); // first sighting
        assert!(s.due(t0 + Duration::from_secs(899), iv, &repos).is_empty());
        assert_eq!(s.due(t0 + iv, iv, &repos), repos);
        s.mark_run("/a", t0 + iv);
        assert_eq!(s.due(t0 + iv + Duration::from_secs(10), iv, &repos), vec!["/b".to_string()]);
    }

    #[test]
    fn pauses_on_auth_and_prunes_closed() {
        let mut s = Scheduler::default();
        let t0 = Instant::now();
        let iv = Duration::from_secs(60);
        let repos = vec!["/a".to_string()];
        s.due(t0, iv, &repos);
        assert!(s.pause("/a"));
        assert!(!s.pause("/a")); // notify once
        assert!(s.due(t0 + iv * 5, iv, &repos).is_empty());
        s.resume_all();
        assert_eq!(s.due(t0 + iv * 5, iv, &repos), repos);
        // closed repos are forgotten
        assert!(s.due(t0 + iv * 6, iv, &[]).is_empty());
        assert!(!s.is_paused("/a"));
    }
}
