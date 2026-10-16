use super::runner::{run, run_raw};
use crate::error::{AppError, Result};
use crate::models::{GitUser, RepoInfo};
use std::path::Path;

pub fn git_version() -> Result<String> {
    let o = run(".", &["--version"], true)?;
    Ok(o.text().split_whitespace().nth(2).unwrap_or("unknown").to_string())
}

pub fn open_repo_info(path: &str) -> Result<RepoInfo> {
    if path.is_empty() {
        return Err(AppError::invalid("empty path"));
    }
    let o = run(
        path,
        &["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"],
        true,
    )?;
    let text = o.text();
    let mut lines = text.lines();
    let top = lines.next().unwrap_or_default().to_string();
    let git_dir = lines.next().unwrap_or_default().to_string();
    let common = lines.next().unwrap_or(&git_dir).to_string();
    if top.is_empty() {
        return Err(AppError::new(crate::error::ErrorCode::NotARepo, "not inside a work tree"));
    }
    let config = |key: &str| -> Result<Option<String>> {
        let o = run_raw(&top, &["config", "--get", key], true)?;
        let v = o.text().trim().to_string();
        Ok(if o.ok() && !v.is_empty() { Some(v) } else { None })
    };
    let remotes = run(&top, &["remote"], true)?
        .text()
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let name = Path::new(&top)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| top.clone());
    Ok(RepoInfo {
        name,
        user: GitUser { name: config("user.name")?, email: config("user.email")? },
        remotes,
        git_version: git_version()?,
        path: top,
        git_dir,
        common_dir: common,
    })
}

/// Stable key for a repository path (locks, watchers, snapshots): the canonical path when it
/// resolves, otherwise the input with trailing separators trimmed.
pub fn canonical_key(path: &str) -> String {
    match std::fs::canonicalize(path) {
        Ok(p) => p.to_string_lossy().into_owned(),
        Err(_) => {
            let t = path.trim_end_matches(['/', '\\']);
            if t.is_empty() { path.to_string() } else { t.to_string() }
        }
    }
}
