//! `git commit -F -` (message on stdin, never argv). Hooks run with the login-shell PATH.
use super::ops::RepoLocks;
use super::runner::{Opts, check_all, run, run_opts, run_raw};
use crate::error::{AppError, Result};
use crate::models::*;

pub fn commit(locks: &RepoLocks, repo: &str, req: &CommitRequest, on_line: &mut dyn FnMut(&str)) -> Result<CommitResult> {
    if req.message.trim().is_empty() {
        return Err(AppError::invalid("commit message is empty"));
    }
    locks.run(repo, || {
        let unborn = !run_raw(repo, &["rev-parse", "-q", "--verify", "HEAD^{commit}"], true)?.ok();
        if req.amend && unborn {
            return Err(AppError::invalid("cannot amend: the repository has no commits yet"));
        }
        let mut args: Vec<&str> = vec!["commit", "-F", "-"];
        if req.amend {
            args.push("--amend");
        }
        if req.sign_off {
            args.push("--signoff");
        }
        if req.allow_empty {
            args.push("--allow-empty");
        }
        let o = run_opts(
            repo,
            &args,
            Opts { timeout: locks.network_timeout, network: false, hooks: true, stdin: Some(req.message.clone().into_bytes()) },
            on_line,
        )?;
        let o = check_all(o)?;
        let hash = run(repo, &["rev-parse", "HEAD"], true)?.text().trim().to_string();
        let summary = o.text();
        let message = summary.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("Committed").to_string();
        Ok(CommitResult { hash, message })
    })
}
