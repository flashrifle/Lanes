//! Push preview + push. Never `--force`; force-with-lease only with an explicit expected hash.
use super::ops::RepoLocks;
use super::runner::{Opts, check_all, check_not_option, norm_hash, run, run_opts, run_raw};
use crate::error::{AppError, Result};
use crate::models::*;

pub const OUTGOING_CAP: usize = 500;

fn cfg(repo: &str, key: &str) -> Result<Option<String>> {
    let o = run_raw(repo, &["config", "--get", key], true)?;
    let v = o.text().trim().to_string();
    Ok((o.ok() && !v.is_empty()).then_some(v))
}

fn current_branch(repo: &str) -> Result<String> {
    let o = run_raw(repo, &["symbolic-ref", "-q", "--short", "HEAD"], true)?;
    let b = o.text().trim().to_string();
    if o.ok() && !b.is_empty() {
        Ok(b)
    } else {
        Err(AppError::invalid("HEAD is detached; check out a branch first"))
    }
}

fn verify(repo: &str, rev: &str) -> Result<Option<String>> {
    let o = run_raw(repo, &["rev-parse", "-q", "--verify", rev], true)?;
    let h = o.text().trim().to_string();
    Ok((o.ok() && !h.is_empty()).then_some(h))
}

pub fn check_branch_ref(repo: &str, kind: &str, name: &str) -> Result<()> {
    check_not_option(kind, name)?;
    if !run_raw(repo, &["check-ref-format", &format!("refs/heads/{name}")], true)?.ok() {
        return Err(AppError::invalid(format!("invalid {kind}: {name:?}")));
    }
    Ok(())
}

pub fn preview(repo: &str, local_branch: Option<&str>) -> Result<PushPreview> {
    let lb = match local_branch {
        Some(b) => b.to_string(),
        None => current_branch(repo)?,
    };
    check_branch_ref(repo, "branch", &lb)?;
    let local_ref = format!("refs/heads/{lb}");
    if verify(repo, &format!("{local_ref}^{{commit}}"))?.is_none() {
        return Err(AppError::invalid(format!("branch '{lb}' has no commits")));
    }
    let remotes: Vec<String> =
        run(repo, &["remote"], true)?.text().lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    let up = run(repo, &["for-each-ref", "--format=%(upstream)", &local_ref], true)?.text().trim().to_string();
    let upstream = (!up.is_empty()).then_some(up);
    let up_remote = cfg(repo, &format!("branch.{lb}.remote"))?.filter(|r| remotes.contains(r));
    let up_branch = cfg(repo, &format!("branch.{lb}.merge"))?.map(|m| m.strip_prefix("refs/heads/").unwrap_or(&m).to_string());
    let remote = up_remote
        .clone()
        .or_else(|| remotes.iter().find(|r| *r == "origin").cloned())
        .or_else(|| remotes.first().cloned());
    let remote_branch = match (&up_remote, &up_branch, &remote) {
        (Some(ur), Some(ub), Some(r)) if ur == r => ub.clone(),
        _ => lb.clone(),
    };
    let remote_ref = remote.as_ref().map(|r| format!("refs/remotes/{r}/{remote_branch}"));
    let remote_hash = match &remote_ref {
        Some(r) => verify(repo, &format!("{r}^{{commit}}"))?,
        None => None,
    };
    let fmt = "--format=%H%x1f%an%x1f%at%x1f%s";
    let cap = format!("-n{OUTGOING_CAP}");
    let log_args: Vec<String> = match (&remote_hash, &remote_ref, &upstream) {
        (Some(_), Some(r), _) => vec!["log".into(), fmt.into(), cap, format!("{r}..{local_ref}")],
        (None, _, Some(u)) if verify(repo, &format!("{u}^{{commit}}"))?.is_some() => {
            vec!["log".into(), fmt.into(), cap, format!("{u}..{local_ref}")]
        }
        _ => vec!["log".into(), fmt.into(), cap, local_ref.clone(), "--not".into(), "--remotes".into()],
    };
    let outgoing = run(repo, &log_args, true)?
        .text()
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\x1f').collect();
            (f.len() == 4).then(|| PushCommit {
                hash: f[0].to_string(),
                author_name: f[1].to_string(),
                author_time: f[2].parse().unwrap_or(0),
                subject: f[3].to_string(),
            })
        })
        .collect();
    let behind = match &remote_hash {
        Some(_) => {
            let r = remote_ref.as_deref().unwrap_or_default();
            run(repo, &["rev-list", "--count", &format!("{local_ref}..{r}")], true)?.text().trim().parse().unwrap_or(0)
        }
        None => 0,
    };
    Ok(PushPreview { local_branch: lb, remotes, remote, remote_branch, upstream, remote_hash, outgoing, behind })
}

pub fn push(locks: &RepoLocks, repo: &str, req: &PushRequest, on_line: &mut dyn FnMut(&str)) -> Result<OpResult> {
    check_not_option("remote", &req.remote)?;
    check_branch_ref(repo, "branch", &req.local_branch)?;
    check_branch_ref(repo, "remote branch", &req.remote_branch)?;
    let lease = match &req.force_with_lease {
        Some(h) => Some(norm_hash(h)?),
        None => None,
    };
    locks.run(repo, || {
        let mut args: Vec<String> = vec!["push".into(), "--progress".into(), "--porcelain".into()];
        if req.set_upstream {
            args.push("-u".into());
        }
        if req.follow_tags {
            args.push("--follow-tags".into());
        }
        if let Some(h) = &lease {
            args.push(format!("--force-with-lease=refs/heads/{}:{h}", req.remote_branch));
        }
        args.push(req.remote.clone());
        args.push(format!("refs/heads/{}:refs/heads/{}", req.local_branch, req.remote_branch));
        let o = run_opts(repo, &args, Opts { timeout: locks.network_timeout, network: true, hooks: true, stdin: None }, on_line)?;
        let o = check_all(o)?;
        let all = o.combined();
        let message = if all.contains("Everything up-to-date") || all.lines().any(|l| l.starts_with('=')) {
            "Everything up-to-date".to_string()
        } else {
            format!("Pushed {} to {}/{}", req.local_branch, req.remote, req.remote_branch)
        };
        Ok(OpResult { message })
    })
}

pub fn push_tag(locks: &RepoLocks, repo: &str, remote: &str, name: &str, on_line: &mut dyn FnMut(&str)) -> Result<OpResult> {
    check_not_option("remote", remote)?;
    check_not_option("tag", name)?;
    if !run_raw(repo, &["check-ref-format", &format!("refs/tags/{name}")], true)?.ok() {
        return Err(AppError::invalid(format!("invalid tag name: {name:?}")));
    }
    locks.run(repo, || {
        let spec = format!("refs/tags/{name}:refs/tags/{name}");
        let args = ["push", "--progress", remote, spec.as_str()];
        let o = run_opts(repo, &args, Opts { timeout: locks.network_timeout, network: true, hooks: true, stdin: None }, on_line)?;
        check_all(o)?;
        Ok(OpResult { message: format!("Pushed tag {name} to {remote}") })
    })
}
