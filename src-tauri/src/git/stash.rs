//! Stash list / save / apply|pop / drop. Apply, pop and drop verify `StashRef.hash` against `stash@{index}`.
use super::ops::RepoLocks;
use super::refs::detect_operation;
use super::runner::{Opts, check_all, check_rel_paths, norm_hash, run, run_opts, run_raw};
use super::status::git_dir_of;
use crate::error::{AppError, Result};
use crate::models::*;
use std::path::Path;

/// "WIP on main: abc subject" / "On main: msg" -> Some("main")
pub fn branch_from_message(m: &str) -> Option<String> {
    let rest = m.strip_prefix("WIP on ").or_else(|| m.strip_prefix("On "))?;
    let (b, _) = rest.split_once(": ")?;
    let b = b.trim();
    (!b.is_empty() && b != "(no branch)").then(|| b.to_string())
}

pub fn list(repo: &str) -> Result<Vec<StashEntry>> {
    let o = run(repo, &["stash", "list", "--format=%H%x1f%ct%x1f%gs"], true)?;
    Ok(o.text()
        .lines()
        .enumerate()
        .filter_map(|(i, l)| {
            let f: Vec<&str> = l.splitn(3, '\x1f').collect();
            (f.len() == 3).then(|| StashEntry {
                index: i as u32,
                hash: f[0].to_string(),
                message: f[2].to_string(),
                branch: branch_from_message(f[2]),
                time: f[1].parse().unwrap_or(0),
            })
        })
        .collect())
}

fn verify_ref(repo: &str, s: &StashRef) -> Result<String> {
    let want = norm_hash(&s.hash)?;
    let sel = format!("stash@{{{}}}", s.index);
    let o = run_raw(repo, &["rev-parse", "-q", "--verify", &sel], true)?;
    if !o.ok() || o.text().trim() != want {
        return Err(AppError::invalid("the stash list changed; refresh and try again"));
    }
    Ok(sel)
}

fn w(locks: &RepoLocks, repo: &str, args: &[&str]) -> Result<super::runner::Output> {
    run_opts(repo, args, Opts { timeout: locks.local_timeout, network: false, hooks: false, stdin: None }, &mut |_| {})
}

pub fn save(locks: &RepoLocks, repo: &str, req: &StashSaveRequest) -> Result<OpResult> {
    if let Some(p) = &req.paths {
        check_rel_paths(p)?;
    }
    locks.run(repo, || {
        // (--literal-pathspecs breaks `stash -u` without pathspecs, so only pass it when paths are given)
        let mut args: Vec<String> = Vec::new();
        if req.paths.is_some() {
            args.push("--literal-pathspecs".into());
        }
        args.extend(["stash".into(), "push".into()]);
        if req.include_untracked {
            args.push("-u".into());
        }
        if req.keep_index {
            args.push("-k".into());
        }
        if let Some(m) = req.message.as_deref().filter(|m| !m.trim().is_empty()) {
            args.push("-m".into());
            args.push(m.to_string());
        }
        if let Some(p) = &req.paths {
            args.push("--".into());
            args.extend(p.iter().cloned());
        }
        let o = check_all(run_opts(repo, &args, Opts { timeout: locks.local_timeout, network: false, hooks: false, stdin: None }, &mut |_| {})?)?;
        let msg = o.summary();
        Ok(OpResult { message: if msg.is_empty() { "Saved working directory".into() } else { msg } })
    })
}

fn has_unmerged(repo: &str) -> Result<bool> {
    Ok(!run(repo, &["diff", "--name-only", "--diff-filter=U"], true)?.stdout.is_empty())
}

fn is_conflict(unmerged_before: bool, unmerged_after: bool, output: &str) -> bool {
    (!unmerged_before && unmerged_after) || output.contains("CONFLICT")
}

pub fn apply(locks: &RepoLocks, repo: &str, s: &StashRef, pop: bool, restore_index: bool) -> Result<OpOutcome> {
    locks.run(repo, || {
        let sel = verify_ref(repo, s)?;
        let mut args = vec!["stash", if pop { "pop" } else { "apply" }];
        if restore_index {
            args.push("--index");
        }
        args.push(&sel);
        let unmerged_before = has_unmerged(repo)?;
        let o = w(locks, repo, &args)?;
        if o.ok() {
            let git_dir = git_dir_of(repo)?;
            return Ok(OpOutcome {
                message: o.summary(),
                conflicts: false,
                operation: detect_operation(Path::new(&git_dir)),
            });
        }
        // A conflict is an outcome (the entry stays on the list for `pop`): the apply itself left unmerged
        // entries behind (or says CONFLICT). Unmerged entries that were already there (a merge in progress)
        // make git refuse the apply, which is a plain error.
        if is_conflict(unmerged_before, has_unmerged(repo)?, &o.combined()) {
            let git_dir = git_dir_of(repo)?;
            return Ok(OpOutcome {
                message: o.summary(),
                conflicts: true,
                operation: detect_operation(Path::new(&git_dir)),
            });
        }
        check_all(o).map(|_| unreachable!("non-zero exit"))
    })
}

pub fn drop_entry(locks: &RepoLocks, repo: &str, s: &StashRef) -> Result<OpResult> {
    locks.run(repo, || {
        let sel = verify_ref(repo, s)?;
        let o = check_all(w(locks, repo, &["stash", "drop", &sel])?)?;
        Ok(OpResult { message: o.summary() })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflict_detection() {
        assert!(is_conflict(false, true, ""));
        assert!(is_conflict(true, true, "CONFLICT (content): Merge conflict in a.txt"));
        assert!(!is_conflict(true, true, "error: Cannot apply a stash in the middle of a merge"));
        assert!(!is_conflict(false, false, "error: could not restore untracked files from stash"));
    }
}
