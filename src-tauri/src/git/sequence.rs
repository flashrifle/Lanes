//! Merge, rebase, cherry-pick, revert, `--continue|--abort|--skip` and reset.
//! Conflicts are an outcome (decided by unmerged entries after the command), not an error.
use super::ops::RepoLocks;
use super::refs::detect_operation;
use super::runner::{Opts, Output, check_all, check_not_option, norm_hash, run, run_opts, run_raw};
use super::status::git_dir_of;
use crate::error::{AppError, Result};
use crate::models::*;
use std::path::Path;

fn current_operation(repo: &str) -> Result<Option<RepoOperation>> {
    let git_dir = git_dir_of(repo)?;
    Ok(detect_operation(Path::new(&git_dir)))
}

fn has_unmerged(repo: &str) -> Result<bool> {
    Ok(!run(repo, &["diff", "--name-only", "--diff-filter=U"], true)?.stdout.is_empty())
}

/// Hook-running command (login PATH, 300 s), output whatever the exit code.
fn exec(locks: &RepoLocks, repo: &str, args: &[String], on_line: &mut dyn FnMut(&str)) -> Result<Output> {
    run_opts(repo, args, Opts { timeout: locks.network_timeout, network: false, hooks: true, stdin: None }, on_line)
}

/// Runs a git command that may stop half-way. `before` = operation in progress before the command.
fn run_outcome(
    locks: &RepoLocks,
    repo: &str,
    args: &[String],
    on_line: &mut dyn FnMut(&str),
    before: Option<RepoOperation>,
) -> Result<OpOutcome> {
    let o = exec(locks, repo, args, on_line)?;
    let operation = current_operation(repo)?;
    let conflicts = has_unmerged(repo)?;
    if o.ok() {
        return Ok(OpOutcome { message: o.summary(), conflicts, operation });
    }
    // Stopped for conflicts (or an empty pick): the command left an operation behind. Not an error.
    if conflicts || (operation.is_some() && before.is_none()) {
        return Ok(OpOutcome { message: o.summary(), conflicts, operation });
    }
    Err(check_all(o).err().unwrap_or_else(|| AppError::internal("non-zero exit expected")))
}

/// cherry-pick / revert / rebase refuse a dirty tree with git's merge wording ("would be overwritten by merge").
fn dirty_remap(mut e: AppError) -> AppError {
    if e.code == crate::error::ErrorCode::WouldOverwrite {
        e.code = crate::error::ErrorCode::DirtyWorktree;
    }
    e
}

pub fn merge(locks: &RepoLocks, repo: &str, req: &MergeRequest, on_line: &mut dyn FnMut(&str)) -> Result<OpOutcome> {
    check_not_option("ref", &req.ref_name)?;
    locks.run(repo, || {
        let before = current_operation(repo)?;
        let mut args: Vec<String> = vec!["merge".into()];
        match req.mode {
            MergeMode::Default => {}
            MergeMode::FfOnly => args.push("--ff-only".into()),
            MergeMode::NoFf => args.push("--no-ff".into()),
            MergeMode::Squash => args.push("--squash".into()),
        }
        match req.message.as_deref().filter(|m| !m.trim().is_empty()) {
            Some(m) if req.mode != MergeMode::FfOnly && req.mode != MergeMode::Squash => {
                args.push("-m".into());
                args.push(m.to_string());
            }
            _ => args.push("--no-edit".into()),
        }
        args.push(req.ref_name.clone());
        run_outcome(locks, repo, &args, on_line, before)
    })
}

pub fn rebase(locks: &RepoLocks, repo: &str, onto: &str, on_line: &mut dyn FnMut(&str)) -> Result<OpOutcome> {
    check_not_option("onto", onto)?;
    locks.run(repo, || {
        let before = current_operation(repo)?;
        // never --autostash, never -i
        let args: Vec<String> = vec!["rebase".into(), onto.to_string()];
        run_outcome(locks, repo, &args, on_line, before).map_err(dirty_remap)
    })
}

pub fn control_operation(
    locks: &RepoLocks,
    repo: &str,
    operation: RepoOperation,
    action: OperationAction,
    on_line: &mut dyn FnMut(&str),
) -> Result<OpOutcome> {
    locks.run(repo, || {
        let before = current_operation(repo)?;
        if before != Some(operation) {
            return Err(AppError::invalid(format!(
                "the repository is not in the expected state (expected {operation:?}, found {before:?})"
            )));
        }
        let cmd = match operation {
            RepoOperation::Merge => "merge",
            RepoOperation::Rebase => "rebase",
            RepoOperation::CherryPick => "cherry-pick",
            RepoOperation::Revert => "revert",
            RepoOperation::Bisect => return Err(AppError::invalid("bisect is not supported")),
        };
        let flag = match action {
            OperationAction::Continue => "--continue",
            OperationAction::Abort => "--abort",
            OperationAction::Skip => {
                if operation == RepoOperation::Merge {
                    return Err(AppError::invalid("a merge cannot be skipped"));
                }
                "--skip"
            }
        };
        // `--continue` with unresolved conflicts is an error; `--skip` / `--abort` do not need them resolved.
        if action == OperationAction::Continue && has_unmerged(repo)? {
            return Err(AppError::new(
                crate::error::ErrorCode::UnmergedFiles,
                "resolve all conflicts and mark them resolved before continuing",
            ));
        }
        let args: Vec<String> = vec![cmd.into(), flag.into()];
        let o = exec(locks, repo, &args, on_line)?;
        let operation_after = current_operation(repo)?;
        let conflicts = has_unmerged(repo)?;
        if o.ok() {
            return Ok(OpOutcome { message: o.summary(), conflicts, operation: operation_after });
        }
        // `--continue`/`--skip` may stop again on the next commit with conflicts.
        if action != OperationAction::Abort && conflicts && operation_after.is_some() {
            return Ok(OpOutcome { message: o.summary(), conflicts, operation: operation_after });
        }
        Err(check_all(o).err().unwrap_or_else(|| AppError::internal("non-zero exit expected")))
    })
}

fn parent_count(repo: &str, hash: &str) -> Result<usize> {
    let o = run_raw(repo, &["rev-list", "--parents", "-n", "1", hash], true)?;
    if !o.ok() {
        return Err(AppError::invalid(format!("unknown commit: {hash}")));
    }
    Ok(o.text().split_whitespace().count().saturating_sub(1))
}

fn pick_hashes(repo: &str, hashes: &[String], mainline: Option<u32>) -> Result<Vec<String>> {
    if hashes.is_empty() {
        return Err(AppError::invalid("no commits given"));
    }
    let norm: Vec<String> = hashes.iter().map(|h| norm_hash(h)).collect::<Result<_>>()?;
    let mut any_merge = false;
    for h in &norm {
        if parent_count(repo, h)? > 1 {
            any_merge = true;
        }
    }
    match (any_merge, mainline) {
        (true, None) => Err(AppError::invalid("a merge commit needs a mainline parent number")),
        (_, Some(0)) => Err(AppError::invalid("mainline must be 1 or greater")),
        _ => Ok(norm),
    }
}

pub fn cherry_pick(locks: &RepoLocks, repo: &str, req: &CherryPickRequest, on_line: &mut dyn FnMut(&str)) -> Result<OpOutcome> {
    locks.run(repo, || {
        let hashes = pick_hashes(repo, &req.hashes, req.mainline)?;
        let before = current_operation(repo)?;
        let mut args: Vec<String> = vec!["cherry-pick".into()];
        if req.record_origin {
            args.push("-x".into());
        }
        if let Some(m) = req.mainline {
            args.push("-m".into());
            args.push(m.to_string());
        }
        args.extend(hashes);
        run_outcome(locks, repo, &args, on_line, before).map_err(dirty_remap)
    })
}

pub fn revert(locks: &RepoLocks, repo: &str, req: &RevertRequest, on_line: &mut dyn FnMut(&str)) -> Result<OpOutcome> {
    locks.run(repo, || {
        let hashes = pick_hashes(repo, &req.hashes, req.mainline)?;
        let before = current_operation(repo)?;
        let mut args: Vec<String> = vec!["revert".into(), "--no-edit".into()];
        if let Some(m) = req.mainline {
            args.push("-m".into());
            args.push(m.to_string());
        }
        args.extend(hashes);
        run_outcome(locks, repo, &args, on_line, before).map_err(dirty_remap)
    })
}

/// Soft / mixed / hard reset. Hard needs `discardLocalChanges` (the UI shows the reflog-recovery warning).
pub fn reset(locks: &RepoLocks, repo: &str, req: &ResetRequest) -> Result<OpResult> {
    let hash = norm_hash(&req.hash)?;
    if req.mode == ResetMode::Hard && !req.discard_local_changes {
        return Err(AppError::invalid("reset --hard discards local changes; discardLocalChanges must be true"));
    }
    locks.run(repo, || {
        if !run_raw(repo, &["rev-parse", "-q", "--verify", &format!("{hash}^{{commit}}")], true)?.ok() {
            return Err(AppError::invalid(format!("unknown commit: {hash}")));
        }
        let flag = match req.mode {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
            ResetMode::Hard => "--hard",
        };
        let o = run_opts(
            repo,
            &["reset", flag, hash.as_str()],
            Opts { timeout: locks.local_timeout, network: false, hooks: true, stdin: None },
            &mut |_| {},
        )?;
        let o = check_all(o)?;
        let msg = o.summary();
        Ok(OpResult { message: if msg.is_empty() { format!("Reset ({flag}) to {}", &hash[..7.min(hash.len())]) } else { msg } })
    })
}
