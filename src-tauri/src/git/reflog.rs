//! Reflog, branch compare and rev ranges (read-only).
use super::runner::{check_not_option, run, run_capped, run_raw};
use crate::error::{AppError, Result};
use crate::models::*;
use std::collections::HashSet;

pub const DEFAULT_LIMIT: u32 = 1000;
/// ~1.5 million commits worth of hashes.
const MAX_RANGE_BYTES: usize = 64 * 1024 * 1024;

/// `%gs` -> (action, message): "commit (amend): msg" -> ("commit (amend)", "msg").
pub fn split_subject(gs: &str) -> (String, String) {
    match gs.split_once(": ") {
        Some((a, m)) => (a.to_string(), m.to_string()),
        None => (gs.to_string(), String::new()),
    }
}

/// Unix time of the reflog entry from `%gd` rendered with `--date=unix` ("HEAD@{1700000000}").
/// This is when the ref moved, not the commit time.
fn selector_time(gd: &str) -> i64 {
    gd.rsplit_once("@{").and_then(|(_, t)| t.strip_suffix('}')).and_then(|t| t.parse().ok()).unwrap_or(0)
}

pub fn reflog(repo: &str, ref_name: Option<&str>, limit: Option<u32>) -> Result<Reflog> {
    let r = ref_name.unwrap_or("HEAD");
    if r != "HEAD" && !r.starts_with("refs/heads/") {
        return Err(AppError::invalid("reflog is available for HEAD and local branches only"));
    }
    check_not_option("ref", r)?;
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, 50_000);
    let sel_name = r.strip_prefix("refs/heads/").unwrap_or(r).to_string();
    // unborn HEAD / branch without reflog: empty list instead of an error
    if !run_raw(repo, &["rev-parse", "-q", "--verify", r], true)?.ok() {
        return Ok(Reflog { ref_name: r.to_string(), entries: Vec::new(), truncated: false });
    }
    let o = run(
        repo,
        &["log", "-g", "--date=unix", "--format=%H%x1f%gd%x1f%gs", &format!("-n{}", limit + 1), r, "--"],
        true,
    )?;
    let mut entries: Vec<ReflogEntry> = o
        .text()
        .lines()
        .enumerate()
        .filter_map(|(i, l)| {
            let f: Vec<&str> = l.splitn(3, '\x1f').collect();
            if f.len() < 3 {
                return None;
            }
            let (action, message) = split_subject(f[2]);
            Some(ReflogEntry {
                selector: format!("{sel_name}@{{{i}}}"),
                hash: f[0].to_string(),
                action,
                message,
                time: selector_time(f[1]),
            })
        })
        .collect();
    let truncated = entries.len() > limit as usize;
    entries.truncate(limit as usize);
    Ok(Reflog { ref_name: r.to_string(), entries, truncated })
}

pub fn compare_refs(repo: &str, a: &str, b: &str) -> Result<CompareSummary> {
    check_not_option("ref", a)?;
    check_not_option("ref", b)?;
    let o = run(repo, &["rev-list", "--left-right", "--count", &format!("{a}...{b}"), "--"], true)?;
    let t = o.text();
    let mut it = t.split_whitespace();
    let a_only = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let b_only = it.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let mb = run_raw(repo, &["merge-base", a, b], true)?;
    let merge_base = (mb.ok() && !mb.text().trim().is_empty()).then(|| mb.text().trim().to_string());
    Ok(CompareSummary { a_only, b_only, merge_base })
}

/// `git rev-list <include> ^<exclude>` as a hash set (for the compare filter).
pub fn rev_range_hashes(repo: &str, r: &RevRange) -> Result<HashSet<String>> {
    check_not_option("include", &r.include)?;
    check_not_option("exclude", &r.exclude)?;
    let (o, truncated) =
        run_capped(repo, &["rev-list", &r.include, &format!("^{}", r.exclude), "--"], MAX_RANGE_BYTES)?;
    if truncated {
        return Err(AppError::new(crate::error::ErrorCode::GitFailed, "the commit range is too large to filter"));
    }
    Ok(o.text().lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selector_times() {
        assert_eq!(selector_time("HEAD@{1700000000}"), 1_700_000_000);
        assert_eq!(selector_time("feature/x@{42}"), 42);
        assert_eq!(selector_time("garbage"), 0);
    }

    #[test]
    fn subjects() {
        assert_eq!(split_subject("commit (amend): fix x"), ("commit (amend)".into(), "fix x".into()));
        assert_eq!(split_subject("checkout: moving from a to b"), ("checkout".into(), "moving from a to b".into()));
        assert_eq!(split_subject("reset"), ("reset".into(), String::new()));
    }
}
