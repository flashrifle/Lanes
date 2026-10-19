//! Write operations. Never `push --force` (force-with-lease only with an explicit expected hash); `reset --hard`
//! is allowed only with `discardLocalChanges: true` (see `sequence::reset`); force branch delete only with an explicit flag.
use super::repo::canonical_key;
use super::runner::{check_not_option, norm_hash, run, run_raw, run_stream};
use crate::error::{AppError, ErrorCode, Result};
use crate::models::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, TryLockError};
use std::time::Duration;

pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(300);
pub const LOCAL_TIMEOUT: Duration = Duration::from_secs(60);

/// Per-repo mutex map (keyed by canonical path): a second write op on the same repo fails with
/// `busy`. The lock is an RAII guard, so it is released on success, error, timeout and panic.
pub struct RepoLocks {
    map: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pub network_timeout: Duration,
    pub local_timeout: Duration,
}

impl Default for RepoLocks {
    fn default() -> Self {
        Self::with_timeouts(NETWORK_TIMEOUT, LOCAL_TIMEOUT)
    }
}

impl RepoLocks {
    pub fn with_timeouts(network_timeout: Duration, local_timeout: Duration) -> Self {
        RepoLocks { map: Mutex::default(), network_timeout, local_timeout }
    }

    pub fn run<T>(&self, repo: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
        let key = canonical_key(repo);
        let m = {
            let mut map = self.map.lock().unwrap_or_else(|p| p.into_inner());
            map.entry(key).or_default().clone()
        };
        let _guard = match m.try_lock() {
            Ok(g) => g,
            Err(TryLockError::WouldBlock) => {
                return Err(AppError::new(ErrorCode::Busy, "another git operation is running on this repository"));
            }
            Err(TryLockError::Poisoned(p)) => p.into_inner(),
        };
        f()
    }
}

pub fn validate_branch_name(repo: &str, name: &str) -> Result<BranchNameCheck> {
    if name.trim().is_empty() {
        return Ok(BranchNameCheck { valid: false, exists: false, message: Some("Branch name is empty".into()) });
    }
    if name.contains('\0') {
        return Ok(BranchNameCheck { valid: false, exists: false, message: Some("Invalid character in name".into()) });
    }
    let o = run_raw(repo, &["check-ref-format", "--branch", name], true)?;
    if !o.ok() {
        let msg = o.stderr.lines().map(str::trim).find(|l| !l.is_empty()).map(|l| l.trim_start_matches("fatal: ").to_string());
        return Ok(BranchNameCheck {
            valid: false,
            exists: false,
            message: Some(msg.unwrap_or_else(|| format!("'{name}' is not a valid branch name"))),
        });
    }
    let exists = run_raw(repo, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")], true)?.ok();
    Ok(BranchNameCheck {
        valid: true,
        exists,
        message: if exists { Some(format!("A branch named '{name}' already exists")) } else { None },
    })
}

fn require_valid_new_branch(repo: &str, name: &str) -> Result<()> {
    let c = validate_branch_name(repo, name)?;
    if !c.valid || c.exists {
        return Err(AppError::invalid(c.message.unwrap_or_else(|| "invalid branch name".into())));
    }
    Ok(())
}

fn local_branch_exists(repo: &str, name: &str) -> Result<bool> {
    Ok(run_raw(repo, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")], true)?.ok())
}

pub fn checkout(
    locks: &RepoLocks,
    repo: &str,
    target: &CheckoutTarget,
    on_line: &mut dyn FnMut(&str),
) -> Result<OpResult> {
    locks.run(repo, || {
        let args: Vec<String> = match target {
            CheckoutTarget::LocalBranch { name } => {
                check_not_option("branch", name)?;
                vec!["checkout".into(), name.clone(), "--".into()]
            }
            CheckoutTarget::RemoteBranch { name, local_name } => {
                check_not_option("remote branch", name)?;
                let local = match local_name {
                    Some(l) => l.clone(),
                    None => name.split_once('/').map(|(_, rest)| rest.to_string()).unwrap_or_else(|| name.clone()),
                };
                check_not_option("local branch", &local)?;
                if local_branch_exists(repo, &local)? {
                    let up = run(repo, &["for-each-ref", "--format=%(upstream)", &format!("refs/heads/{local}")], true)?
                        .text()
                        .trim()
                        .to_string();
                    if up != format!("refs/remotes/{name}") {
                        return Err(AppError::invalid(format!(
                            "local branch '{local}' already exists and does not track '{name}'"
                        )));
                    }
                    vec!["checkout".into(), local, "--".into()]
                } else {
                    vec!["checkout".into(), "-b".into(), local, "--track".into(), format!("refs/remotes/{name}")]
                }
            }
            CheckoutTarget::Tag { name } => {
                check_not_option("tag", name)?;
                let full = if name.starts_with("refs/") { name.clone() } else { format!("refs/tags/{name}") };
                vec!["checkout".into(), "--detach".into(), full]
            }
            CheckoutTarget::Commit { hash } => {
                let h = norm_hash(hash)?;
                vec!["checkout".into(), "--detach".into(), h]
            }
        };
        let o = run_stream(repo, &args, locks.local_timeout, false, on_line)?;
        Ok(OpResult { message: o.summary() })
    })
}

pub fn fetch(locks: &RepoLocks, repo: &str, remote: Option<&str>, on_line: &mut dyn FnMut(&str)) -> Result<OpResult> {
    locks.run(repo, || {
        let mut args: Vec<String> = vec!["fetch".into(), "--prune".into(), "--progress".into()];
        match remote {
            Some(r) => {
                check_not_option("remote", r)?;
                args.push(r.to_string());
            }
            None => args.push("--all".into()),
        }
        let o = run_stream(repo, &args, locks.network_timeout, true, on_line)?;
        Ok(OpResult { message: o.summary() })
    })
}

pub fn pull(locks: &RepoLocks, repo: &str, mode: PullMode, on_line: &mut dyn FnMut(&str)) -> Result<OpResult> {
    locks.run(repo, || {
        let flags: &[&str] = match mode {
            PullMode::FfOnly => &["--ff-only"],
            PullMode::Rebase => &["--rebase"],
            PullMode::Merge => &["--no-rebase", "--no-edit"],
        };
        let mut args = vec!["pull", "--progress"];
        args.extend_from_slice(flags);
        let o = run_stream(repo, &args, locks.network_timeout, true, on_line)?;
        Ok(OpResult { message: o.summary() })
    })
}

pub fn create_branch(
    locks: &RepoLocks,
    repo: &str,
    name: &str,
    start_point: &str,
    checkout: bool,
) -> Result<OpResult> {
    locks.run(repo, || {
        require_valid_new_branch(repo, name)?;
        check_not_option("start point", start_point)?;
        let args: Vec<&str> =
            if checkout { vec!["checkout", "-b", name, start_point] } else { vec!["branch", name, start_point] };
        let o = run_stream(repo, &args, locks.local_timeout, false, &mut |_| {})?;
        let msg = o.summary();
        Ok(OpResult {
            message: if msg.is_empty() { format!("Created branch '{name}'") } else { msg },
        })
    })
}

pub fn delete_branch(locks: &RepoLocks, repo: &str, name: &str, force: bool) -> Result<OpResult> {
    locks.run(repo, || {
        check_not_option("branch", name)?;
        let cur = run_raw(repo, &["symbolic-ref", "-q", "--short", "HEAD"], true)?;
        if cur.ok() && cur.text().trim() == name {
            return Err(AppError::invalid("cannot delete the currently checked out branch"));
        }
        let flag = if force { "-D" } else { "-d" };
        let o = run_stream(repo, &["branch", flag, name], locks.local_timeout, false, &mut |_| {})?;
        Ok(OpResult { message: o.summary() })
    })
}
