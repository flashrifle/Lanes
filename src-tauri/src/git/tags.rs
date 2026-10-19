//! Tags: validate / create (lightweight or annotated via stdin) / delete. Never `-f`.
use super::ops::RepoLocks;
use super::runner::{Opts, check_all, check_not_option, norm_hash, run_opts, run_raw};
use crate::error::{AppError, Result};
use crate::models::*;

pub fn validate_tag_name(repo: &str, name: &str) -> Result<RefNameCheck> {
    if name.trim().is_empty() {
        return Ok(RefNameCheck { valid: false, exists: false, message: Some("Tag name is empty".into()) });
    }
    if name.starts_with('-') || name.contains('\0') {
        return Ok(RefNameCheck { valid: false, exists: false, message: Some(format!("'{name}' is not a valid tag name")) });
    }
    let o = run_raw(repo, &["check-ref-format", &format!("refs/tags/{name}")], true)?;
    if !o.ok() {
        return Ok(RefNameCheck { valid: false, exists: false, message: Some(format!("'{name}' is not a valid tag name")) });
    }
    let exists = run_raw(repo, &["show-ref", "--verify", "--quiet", &format!("refs/tags/{name}")], true)?.ok();
    Ok(RefNameCheck {
        valid: true,
        exists,
        message: exists.then(|| format!("A tag named '{name}' already exists")),
    })
}

pub fn create_tag(locks: &RepoLocks, repo: &str, req: &CreateTagRequest) -> Result<OpResult> {
    let target = norm_hash(&req.target)?;
    let c = validate_tag_name(repo, &req.name)?;
    if !c.valid || c.exists {
        return Err(AppError::invalid(c.message.unwrap_or_else(|| "invalid tag name".into())));
    }
    if let Some(m) = &req.message
        && m.trim().is_empty()
    {
        return Err(AppError::invalid("tag message is empty"));
    }
    locks.run(repo, || {
        let (args, stdin): (Vec<&str>, Option<Vec<u8>>) = match &req.message {
            Some(m) => (vec!["tag", "-a", "-F", "-", &req.name, &target], Some(m.clone().into_bytes())),
            None => (vec!["tag", &req.name, &target], None),
        };
        let o = run_opts(repo, &args, Opts { timeout: locks.local_timeout, network: false, hooks: false, stdin }, &mut |_| {})?;
        check_all(o)?;
        Ok(OpResult { message: format!("Created tag {}", req.name) })
    })
}

pub fn delete_tag(locks: &RepoLocks, repo: &str, name: &str) -> Result<OpResult> {
    check_not_option("tag", name)?;
    locks.run(repo, || {
        if !run_raw(repo, &["show-ref", "--verify", "--quiet", &format!("refs/tags/{name}")], true)?.ok() {
            return Err(AppError::invalid(format!("tag '{name}' does not exist")));
        }
        let o = run_opts(repo, &["tag", "-d", name], Opts { timeout: locks.local_timeout, network: false, hooks: false, stdin: None }, &mut |_| {})?;
        check_all(o)?;
        Ok(OpResult { message: format!("Deleted tag {name}") })
    })
}
